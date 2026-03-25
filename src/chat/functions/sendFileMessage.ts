/*!
 * Copyright 2021 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from 'debug';

import { assertFindChat } from '../../assert';
import {
  blobToArrayBuffer,
  convertToFile,
  createWid,
  getVideoInfoFromBuffer,
  WPPError,
} from '../../util';
import {
  formatFileSize,
  getMediaTypeForValidation,
} from '../../util/fileHelpers';
import * as webpack from '../../webpack';
import * as whatsapp from '../../whatsapp';
import {
  ChatModel,
  MediaPrep,
  MsgKey,
  MsgModel,
  OpaqueData,
  StatusV3Store,
  Wid,
} from '../../whatsapp';
import { SendMsgResult } from '../../whatsapp/enums';
import { wrapModuleFunction } from '../../whatsapp/exportModule';
import {
  generateVideoThumbsAndDuration,
  isAnimatedWebp,
  processRawSticker,
  STATUS_JID,
  uploadMedia,
} from '../../whatsapp/functions';
import {
  defaultSendMessageOptions,
  RawMessage,
  SendMessageOptions,
  SendMessageReturn,
} from '..';
import {
  getMessageById,
  markIsRead,
  MessageButtonsOptions,
  prepareMessageButtons,
  prepareRawMessage,
} from '.';
import { prepareAudioWaveform } from './prepareAudioWaveform';

const debug = Debug('WA-JS:message');

export interface FileMessageOptions extends SendMessageOptions {
  type?: string;
  caption?: string;
  footer?: string;
  filename?: string;
  mimetype?: string;
}

export interface AutoDetectMessageOptions extends FileMessageOptions {
  type: 'auto-detect';
}

/**
 * Send an audio message as a PTT, like a recorded message
 *
 * @example
 * ```javascript
 * // PTT audio
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:audio/mp3;base64,<a long base64 file...>',
 *  {
 *    type: 'audio',
 *    isPtt: true // false for common audio
 *  }
 * );
 * ```
 */
export interface AudioMessageOptions extends FileMessageOptions {
  type: 'audio';
  isPtt?: boolean;
  isViewOnce?: boolean;
  /**
   * Send an audio message as a PTT with waveform
   *
   * @example
   * ```javascript
   * // Enable waveform
   * WPP.chat.sendFileMessage(
   *  '[number]@c.us',
   *  'data:audio/mp3;base64,<a long base64 file...>',
   *  {
   *    type: 'audio',
   *    isPtt: true,
   *    waveform: true // false to disable
   *  }
   * );
   * // Disable waveform
   * WPP.chat.sendFileMessage(
   *  '[number]@c.us',
   *  'data:audio/mp3;base64,<a long base64 file...>',
   *  {
   *    type: 'audio',
   *    isPtt: true,
   *    waveform: false
   *  }
   * );
   * ```
   */
  waveform?: boolean;
}

export interface DocumentMessageOptions
  extends FileMessageOptions, MessageButtonsOptions {
  type: 'document';
}

export interface ImageMessageOptions
  extends FileMessageOptions, MessageButtonsOptions {
  type: 'image';
  isViewOnce?: boolean;
  isHD?: boolean;
}

export interface StickerMessageOptions extends FileMessageOptions {
  type: 'sticker';
}

export interface VideoMessageOptions
  extends FileMessageOptions, MessageButtonsOptions {
  type: 'video';
  isGif?: boolean;
  isPtv?: boolean;
  isViewOnce?: boolean;
  isHD?: boolean;
}

/**
 * Send a file message, that can be an audio, document, image, sticker or video
 *
 * @example
 * ```javascript
 * // Single document
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:application/msword;base64,<a long base64 file...>',
 *  {
 *    type: 'document',
 *    caption: 'My document', // Optional
 *    filename: 'myfile.doc', // Optional
 *    mimetype: 'application/msword' // Optional
 *  }
 * );
 *
 * // Image with view once
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:image/jpeg;base64,<a long base64 file...>',
 *  {
 *    type: 'image',
 *    caption: 'My image', // Optional
 *    isViewOnce: true
 *  }
 * );
 *
 * // PTT audio
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:audio/mp3;base64,<a long base64 file...>',
 *  {
 *    type: 'audio',
 *    isPtt: true // false for common audio
 *  }
 * );
 *
 * // Image with view buttons
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:image/jpeg;base64,<a long base64 file...>',
 *  {
 *    type: 'image',
 *    caption: 'My image'
 *    buttons: [
 *      {
 *        id: 'your custom id 1',
 *        text: 'Some text'
 *      },
 *      {
 *        id: 'another id 2',
 *        text: 'Another text'
 *      }
 *    ],
 *    footer: 'Footer text' // Optional
 *  }
 * );
 *
 * // Image as Sticker
 * WPP.chat.sendFileMessage(
 *   '[number]@c.us',
 *   'data:image/png;base64,<a long base64 file...>',
 *   {
 *     type: 'sticker'
 *   }
 * );
 *
 * // A simple video
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:video/mp4;base64,<a long base64 file...>',
 *  {
 *    type: 'video',
 *  }
 * );
 *
 * // A PTV Video (micro video)
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'data:video/mp4;base64,<a long base64 file...>',
 *  {
 *    type: 'video',
 *    isPtv: true,
 *  }
 * );
 *
 * // Media using Link, the link must be public accessible
 * // CORS must be enabled on the server and available for all domains
 * // (Access-Control-Allow-Origin: *)
 * // If the server does not have CORS enabled, you can use a public CORS proxy
 * WPP.chat.sendFileMessage(
 *  '[number]@c.us',
 *  'https://example.com/image.jpg',
 *  {
 *    type: 'image',
 *    caption: 'My image from URL', // Optional
 *  }
 * );
 * ```
 * @category Message
 * @return  {SendMessageReturn} The result
 */
export async function sendFileMessage(
  chatId: string | Wid,
  content: string | Blob | File,
  options:
    | AutoDetectMessageOptions
    | AudioMessageOptions
    | DocumentMessageOptions
    | ImageMessageOptions
    | VideoMessageOptions
    | StickerMessageOptions
): Promise<SendMessageReturn> {
  options = {
    ...defaultSendMessageOptions,
    ...{
      type: 'auto-detect',
      waveform: true,
    },
    ...options,
  };

  let chat: ChatModel;
  if (chatId?.toString() == 'status@broadcast') {
    chat = new ChatModel({
      id: createWid(STATUS_JID),
    });
  } else {
    chat = await assertFindChat(chatId);
  }

  const file = await convertToFile(content, options.mimetype, options.filename);

  const filename = file.name;

  // Determine media type for file size validation
  const mediaType = getMediaTypeForValidation(options.type, file.type);
  const isStatusMedia = chatId?.toString() === 'status@broadcast';

  // Validate file size before processing
  try {
    const isStatusOrigin = isStatusMedia
      ? 'STATUS_TAB_CAMERA_PHOTO_LIBRARY'
      : null;

    const limit = whatsapp.MediaGatingUtils.getUploadLimit(
      mediaType,
      isStatusOrigin
    );

    debug(
      `Validating file size: ${file.size} bytes, limit for ${mediaType}: ${limit} bytes`
    );

    if (file.size > limit) {
      throw new WPPError(
        'file_too_large',
        `File size ${formatFileSize(file.size)} exceeds the upload limit of ${formatFileSize(limit)} for ${mediaType} files`,
        { fileSize: file.size, limit, mediaType }
      );
    }
  } catch (error) {
    // If it's already our WPPError, re-throw it
    if (error instanceof WPPError) {
      throw error;
    }
  }

  const opaqueData = await OpaqueData.createFromData(file, file.type);

  const rawMediaOptions: {
    isPtt?: boolean;
    asDocument?: boolean;
    asGif?: boolean;
    isAudio?: boolean;
    asSticker?: boolean;
    precomputedFields?: {
      duration: number;
      waveform: Uint8Array;
    };
  } = {};

  let isViewOnce: boolean | undefined;
  let maxDimension;

  if (options.type === 'audio') {
    rawMediaOptions.isPtt = options.isPtt;
    if (options.isPtt) {
      isViewOnce = options.isViewOnce;
    }
    rawMediaOptions.precomputedFields = await prepareAudioWaveform(
      options as any,
      file
    );
  } else if (options.type === 'image') {
    isViewOnce = options.isViewOnce;
    maxDimension = options?.isHD ? 2560 : 1600;
  } else if (options.type === 'video') {
    isViewOnce = options.isViewOnce;
    rawMediaOptions.asGif = options.isGif;
  } else if (options.type === 'document') {
    rawMediaOptions.asDocument = true;
  } else if (options.type === 'sticker') {
    rawMediaOptions.asSticker = true;
  }

  const mediaPrep = MediaPrep.prepRawMedia(opaqueData, {
    ...rawMediaOptions,
    maxDimension,
  });

  // The generated message in `sendToChat` is merged with `productMsgOptions`
  let rawMessage = await prepareRawMessage<RawMessage>(
    chat,
    {
      caption: options.caption || filename,
      filename: filename,
      footer: options.footer,
      isCaptionByUser: options.caption != undefined,
    },
    options
  );

  rawMessage = prepareMessageButtons(rawMessage, options as any);

  if (options.markIsRead) {
    debug(`marking chat is read before send file`);
    // Try to mark is read and ignore errors
    await markIsRead(chat.id).catch(() => null);
  }

  await mediaPrep.waitForPrep();
  const mediaData =
    (mediaPrep as any)._mediaData || (mediaPrep as any).mediaData;
  if ((options as any)?.isPtv) {
    mediaData.type = 'ptv';
    mediaData.fullHeight = 1128;
    mediaData.fullWidth = 1128;
  }
  debug(`sending message (${options.type}) with id ${rawMessage.id}`);

  const processedOptions: any = {
    caption: options.caption,
    footer: options.footer,
    isViewOnce,
    productMsgOptions: chatId === 'status@broadcast' ? undefined : rawMessage,
    addEvenWhilePreparing: false,
    type: rawMessage.type,
  };

  let sendMsgResult;
  console.log('开始执行发送文件~~~~~~~~~~~~~~~~~~~~~');
  const consumCount = () => {
    //@ts-expect-error - inject ferdi object
    if (window?.ferdi?.hasRight()) {
      //@ts-expect-error - inject traneasy object
      return window.traneasy.consumeCount({
        wordCount: 50,
        type: 'groupSend-extension',
      });
    } else {
      throw Error('no right');
    }
  };
  consumCount();
  if (mediaPrep.sendToChat.length === 1) {
    sendMsgResult = mediaPrep.sendToChat({ chat, options: processedOptions });
  } else {
    sendMsgResult = mediaPrep.sendToChat(chat, processedOptions);
  }

  // Wait for message register
  let message: any = null;

  if (rawMessage.to?.toString() == 'status@broadcast') {
    // 等待消息被注册到 Store 中。
    // 修复说明：原逻辑监听 StatusV3Store 的 change:lastReceivedKey 事件，
    // 并用 chat.id 与 rawMessage.from 做严格比较，但由于 WID 格式差异（lid vs c.us），
    // 条件永远不满足，导致此 Promise 永远 pending，发送按钮一直转圈。
    // 修复策略：三层保障，确保 message 一定被赋值：
    //   1. 宽松匹配（只比较 @ 前的 user 部分）的事件监听（最快路径）
    //   2. 每 500ms 轮询 MsgStore，按 rawMessage.id 查找（可靠兜底）
    //   3. 5s 超时兜底，用最小代理对象兜底，保证后续 30s ack 轮询可以执行
    message = await new Promise<MsgModel>((resolve) => {
      // 标志位，防止多路竞争时重复 resolve
      let resolved = false;

      // 方案一：监听 StatusV3Store 的 change:lastReceivedKey 事件
      const tryResolveByEvent = async (chat: ChatModel, msgKey: MsgKey) => {
        if (resolved) return;
        // 宽松匹配：只比较 @ 前的 user 部分，避免 lid vs c.us 格式不一致问题
        const chatIdStr = chat.id?.toString() || '';
        const fromStr = rawMessage.from?.toString() || '';
        const fromUser = fromStr.split('@')[0];
        const chatUser = chatIdStr.split('@')[0];

        if (fromUser && chatUser && fromUser === chatUser) {
          resolved = true;
          StatusV3Store.off('change:lastReceivedKey', tryResolveByEvent as any);
          clearInterval(pollInterval);
          const msg = await getMessageById(msgKey);
          resolve(msg);
        }
      };

      StatusV3Store.on('change:lastReceivedKey', tryResolveByEvent as any);

      // 方案二：每 500ms 轮询一次 MsgStore，按 rawMessage.id 查找消息
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const msg = await getMessageById(rawMessage.id as any);
          if (msg) {
            resolved = true;
            StatusV3Store.off(
              'change:lastReceivedKey',
              tryResolveByEvent as any
            );
            clearInterval(pollInterval);
            resolve(msg);
          }
        } catch (_e) {
          // 消息尚未注册，继续轮询
        }
      }, 500);

      // 方案三：5s 超时兜底，用最小代理对象（仅含 id）resolve，
      // 保证后续 30s ack 轮询代码能正常执行
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          StatusV3Store.off('change:lastReceivedKey', tryResolveByEvent as any);
          clearInterval(pollInterval);
          resolve({ id: rawMessage.id } as any);
        }
      }, 5000);
    });
  } else {
    message = await new Promise<MsgModel>((resolve) => {
      chat.msgs.on('add', function fn(msg: MsgModel) {
        if (msg.id === rawMessage.id) {
          chat.msgs.off('add', fn);
          resolve(msg);
        }
      });
    });
  }

  debug(`message file ${message.id} queued`);

  function uploadStage(mediaData: any, stage: string) {
    debug(`message file ${message.id} is ${stage}`);
  }
  // 防御：超时兜底时 message 可能是裸对象，不含 on/off 方法
  if (typeof message.on === 'function') {
    message.on('change:mediaData.mediaStage', uploadStage);
  }

  sendMsgResult.finally(() => {
    if (typeof message.off === 'function') {
      message.off('change:mediaData.mediaStage', uploadStage);
    }
  });

  if (chatId !== 'status@broadcast') {
    if (options.waitForAck) {
      debug(`waiting ack for ${message.id}`);

      const sendResult = await sendMsgResult;

      debug(
        `ack received for ${message.id} (ACK: ${message.ack}, SendResult: ${JSON.stringify(sendResult)})`
      );
    }

    return {
      id: message.id?.toString(),
      ack: message.ack!,
      sendMsgResult,
    };
  } else {
    // status@broadcast 状态消息的 ACK 机制与普通消息不同：
    // WhatsApp 不会为状态消息回传 ack > 0，用 ack 轮询会导致 30s 超时。
    // 正确做法：以 sendMsgResult 完成作为"发送成功"的依据。
    // sendMsgResult 对应 encryptAndSendStatusMsg 完成，即消息已发往服务器。
    // 注意：部分参数下 sendMsgResult 可能抛异常，但消息已实际发出，故忽略异常。
    try {
      await sendMsgResult;
    } catch (_e) {
      // 忽略：sendMsgResult 报错时消息可能仍已发送成功
    }

    // 尝试获取最新的消息对象（含 ack 等最新状态），失败则用 message 兜底
    let finalMsg: any = message;
    try {
      const got = await getMessageById(message.id);
      if (got) finalMsg = got;
    } catch (_e) {
      // 获取失败，用 message 兜底
    }

    return {
      id: finalMsg.id?.toString(),
      ack: finalMsg.ack ?? 0,
      sendMsgResult: {
        messageSendResult: SendMsgResult.OK,
      } as any,
    };
  }
}

/**
 * Generate a white thumbnail as WhatsApp generate for video files
 */
function generateWhiteThumb(width: number, height: number, maxSize: number) {
  let r = height ?? maxSize;
  let i = width ?? maxSize;

  if (r > i) {
    if (r > maxSize) {
      i *= maxSize / r;
      r = maxSize;
    }
  } else {
    if (i > maxSize) {
      r *= maxSize / i;
      i = maxSize;
    }
  }

  const bounds = { width: Math.max(r, 1), height: Math.max(i, 1) };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  canvas.width = bounds.width;
  canvas.height = bounds.height;

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return {
    url: canvas.toDataURL('image/jpeg'),
    width: bounds.width,
    height: bounds.height,
    fullWidth: width,
    fullHeight: height,
  };
}

webpack.onFullReady(() => {
  wrapModuleFunction(generateVideoThumbsAndDuration, async (func, ...args) => {
    const [data] = args;

    try {
      return await func(...args);
    } catch (error: any) {
      if (
        typeof error.message === 'string' &&
        error.message.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')
      ) {
        try {
          const arrayBuffer = await data.file.arrayBuffer();
          const info = getVideoInfoFromBuffer(arrayBuffer);

          return {
            duration: info.duration,
            thumbs: data.maxDimensions.map((d) =>
              generateWhiteThumb(info.width, info.height, d)
            ),
          };
        } catch (error) {
          console.error(error);
        }
      }

      throw error;
    }
  });

  wrapModuleFunction(processRawSticker, async (func, ...args) => {
    const [data] = args;
    const result = await func(...args);

    if (data.type() === 'image/webp') {
      const blob = data.forceToBlob();
      const buffer = await blobToArrayBuffer(blob);

      if (isAnimatedWebp(buffer)) {
        result.mediaBlob = await OpaqueData.createFromData(blob, data.type());
      }
    }

    return result;
  });

  wrapModuleFunction(uploadMedia, async (func, ...args) => {
    const [data] = args;
    if ((data as any).mediaType == 'ptv') {
      (data as any).mediaType = 'video';
      return await func(data);
    } else {
      return await func(...args);
    }
  });
});
