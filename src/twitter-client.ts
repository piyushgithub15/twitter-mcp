import { readFile } from "node:fs/promises";
import {
  TwitterApi,
  EUploadMimeType,
  type TweetV2PostTweetResult,
  type UserV2,
} from "twitter-api-v2";
import { getAccessToken } from "./auth.js";

/** Mirrors twitter-api-v2 MediaV2MediaCategory (not re-exported from package root). */
export type MediaCategory =
  | "tweet_image"
  | "tweet_video"
  | "tweet_gif"
  | "dm_image"
  | "dm_video"
  | "dm_gif"
  | "subtitles"
  | "amplify_video";

const DEFAULT_USER_FIELDS = [
  "id",
  "name",
  "username",
  "description",
  "created_at",
  "public_metrics",
  "profile_image_url",
  "verified",
  "protected",
  "url",
  "location",
] as const;

const DEFAULT_TWEET_FIELDS = [
  "id",
  "text",
  "created_at",
  "author_id",
  "public_metrics",
  "conversation_id",
  "in_reply_to_user_id",
  "lang",
  "possibly_sensitive",
  "referenced_tweets",
  "entities",
] as const;

/** Max bytes we will load into memory for a single media upload (512 MB). */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

const VIDEO_MIME_TYPES = new Set([
  EUploadMimeType.Mp4,
  EUploadMimeType.Mov,
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const IMAGE_MIME_TYPES = new Set([
  EUploadMimeType.Jpeg,
  EUploadMimeType.Png,
  EUploadMimeType.Gif,
  EUploadMimeType.Webp,
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type MediaSource =
  | { kind: "url"; url: string }
  | { kind: "path"; path: string }
  | { kind: "base64"; data: string };

function client() {
  return new TwitterApi(getAccessToken());
}

function inferMimeFromPathOrUrl(source: string): string | undefined {
  const lower = source.split("?")[0]?.toLowerCase() ?? "";
  if (lower.endsWith(".mp4")) return EUploadMimeType.Mp4;
  if (lower.endsWith(".mov") || lower.endsWith(".qt")) return EUploadMimeType.Mov;
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".gif")) return EUploadMimeType.Gif;
  if (lower.endsWith(".png")) return EUploadMimeType.Png;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return EUploadMimeType.Jpeg;
  if (lower.endsWith(".webp")) return EUploadMimeType.Webp;
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  return undefined;
}

function normalizeMimeType(mime: string): string {
  const cleaned = mime.trim().toLowerCase().split(";")[0]?.trim() ?? mime;
  // Common aliases
  if (cleaned === "image/jpg") return EUploadMimeType.Jpeg;
  return cleaned;
}

/** Content-Types too generic to trust over path extension / magic bytes. */
function isGenericContentType(mime: string | undefined): boolean {
  if (!mime) return true;
  const m = normalizeMimeType(mime);
  return (
    m === "application/octet-stream" ||
    m === "binary/octet-stream" ||
    m === "application/binary" ||
    m === "application/force-download" ||
    m === "application/x-download"
  );
}

/**
 * Sniff container type from magic bytes (more reliable than Azure blob Content-Type).
 */
function detectFormatFromMagic(buffer: Buffer): {
  kind: "video" | "image" | "audio" | "unknown";
  mime?: string;
  label: string;
} {
  if (buffer.length < 12) {
    return { kind: "unknown", label: "unknown (file too small)" };
  }

  // ID3 tag (MP3) or raw MPEG frame sync
  if (
    buffer.subarray(0, 3).toString("ascii") === "ID3" ||
    (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)
  ) {
    return { kind: "audio", mime: "audio/mpeg", label: "MP3 audio" };
  }

  // RIFF....WAVE
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return { kind: "audio", mime: "audio/wav", label: "WAV audio" };
  }

  // RIFF....AVI / WEBP handled below via RIFF
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "image", mime: EUploadMimeType.Webp, label: "WebP image" };
  }

  // Ogg
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return { kind: "audio", mime: "audio/ogg", label: "Ogg audio" };
  }

  // ftyp box (MP4/MOV/M4A) — brand indicates video vs audio-ish
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").replace(/\0/g, "");
    const audioBrands = new Set(["M4A ", "M4B ", "mp41", "mp42"]); // mp4* can be either; M4A is audio
    if (brand === "M4A " || brand === "M4B ") {
      return { kind: "audio", mime: "audio/mp4", label: `M4A audio (brand ${brand})` };
    }
    // Most other ftyp brands used for tweetable video
    if (
      brand.startsWith("isom") ||
      brand.startsWith("iso") ||
      brand.startsWith("mp4") ||
      brand === "avc1" ||
      brand === "qt  " ||
      brand.includes("mp4")
    ) {
      return { kind: "video", mime: EUploadMimeType.Mp4, label: `MP4/MOV video (brand ${brand})` };
    }
    // Unknown ftyp — treat as video-capable container unless M4A already handled
    if (!audioBrands.has(brand)) {
      return { kind: "video", mime: EUploadMimeType.Mp4, label: `ISO-BMFF media (brand ${brand})` };
    }
  }

  // PNG / JPEG / GIF
  if (
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return { kind: "image", mime: EUploadMimeType.Png, label: "PNG image" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: "image", mime: EUploadMimeType.Jpeg, label: "JPEG image" };
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { kind: "image", mime: EUploadMimeType.Gif, label: "GIF image" };
  }

  // WebM / Matroska
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { kind: "video", mime: "video/webm", label: "WebM/Matroska video" };
  }

  return { kind: "unknown", label: "unknown binary" };
}

/**
 * Reject payloads that cannot succeed as tweet media (e.g. MP3 labeled as video/mp4).
 */
function assertMediaCompatible(params: {
  buffer: Buffer;
  mediaType: string;
  mediaCategory: MediaCategory;
  sourceHint?: string;
}): void {
  const detected = detectFormatFromMagic(params.buffer);
  const wantsVideo =
    params.mediaCategory === "tweet_video" ||
    params.mediaCategory === "amplify_video" ||
    params.mediaCategory === "dm_video" ||
    params.mediaType.startsWith("video/");
  const wantsImage =
    params.mediaCategory === "tweet_image" ||
    params.mediaCategory === "dm_image" ||
    (params.mediaType.startsWith("image/") && !params.mediaType.includes("gif"));
  const wantsGif =
    params.mediaCategory === "tweet_gif" ||
    params.mediaCategory === "dm_gif" ||
    params.mediaType === "image/gif";

  if (detected.kind === "audio" || params.mediaType.startsWith("audio/")) {
    throw new Error(
      `Cannot upload audio as tweet media. Detected ${detected.label}` +
        (params.sourceHint ? ` from ${params.sourceHint}` : "") +
        `. X posts only accept images, GIF, or video (H.264 MP4/MOV) — not MP3/M4A/WAV. ` +
        `Convert the audio to a video file (e.g. waveform or static image + audio in MP4) and re-upload with media_type=video/mp4.`,
    );
  }

  if (wantsVideo && detected.kind === "image") {
    throw new Error(
      `media_category/media_type request video but file is ${detected.label}. Use tweet_image / image/* instead.`,
    );
  }

  if ((wantsImage || wantsGif) && detected.kind === "video") {
    throw new Error(
      `media_category/media_type request image/GIF but file is ${detected.label}. Use tweet_video / video/mp4 instead.`,
    );
  }

  if (wantsVideo && detected.kind === "unknown") {
    // Soft warning path: still allow, Twitter will reject if invalid — but flag clearly if extension says audio
    const hint = params.sourceHint?.toLowerCase() ?? "";
    if (/\.(mp3|wav|aac|m4a|ogg|oga)(\?|$)/.test(hint)) {
      throw new Error(
        `URL/path looks like audio (${params.sourceHint}) but media_type=${params.mediaType}. ` +
          `X does not accept bare audio as tweet_video.`,
      );
    }
  }
}

function inferMediaCategory(mimeType: string): MediaCategory {
  if (mimeType.includes("gif")) return "tweet_gif";
  if (VIDEO_MIME_TYPES.has(mimeType) || mimeType.startsWith("video/")) {
    return "tweet_video";
  }
  if (IMAGE_MIME_TYPES.has(mimeType) || mimeType.startsWith("image/")) {
    return "tweet_image";
  }
  throw new Error(
    `Unsupported media_type "${mimeType}". Use video/mp4, video/quicktime, image/jpeg, image/png, image/gif, or image/webp.`,
  );
}

function stripDataUrlPrefix(base64: string): string {
  const match = /^data:[^;]+;base64,(.+)$/s.exec(base64);
  return match?.[1] ?? base64;
}

async function loadMediaBuffer(source: MediaSource): Promise<{
  buffer: Buffer;
  inferredMime?: string;
}> {
  if (source.kind === "base64") {
    const raw = stripDataUrlPrefix(source.data).replace(/\s/g, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) {
      throw new Error("media_base64 decoded to empty buffer");
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error(
        `Media exceeds max size of ${MAX_MEDIA_BYTES} bytes (${buffer.length} bytes)`,
      );
    }
    return { buffer };
  }

  if (source.kind === "path") {
    const buffer = await readFile(source.path);
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error(
        `Media exceeds max size of ${MAX_MEDIA_BYTES} bytes (${buffer.length} bytes)`,
      );
    }
    return {
      buffer,
      inferredMime: inferMimeFromPathOrUrl(source.path),
    };
  }

  // URL download
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    throw new Error(`Invalid media_url: ${source.url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("media_url must be an http(s) URL");
  }

  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { Accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download media_url (HTTP ${response.status} ${response.statusText})`,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_MEDIA_BYTES) {
    throw new Error(
      `Media exceeds max size of ${MAX_MEDIA_BYTES} bytes (Content-Length ${contentLength})`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) {
    throw new Error("media_url downloaded empty body");
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(
      `Media exceeds max size of ${MAX_MEDIA_BYTES} bytes (${buffer.length} bytes)`,
    );
  }

  const headerMime = response.headers.get("content-type") ?? undefined;
  const fromHeader =
    headerMime && !isGenericContentType(headerMime)
      ? normalizeMimeType(headerMime)
      : undefined;
  // Prefer path extension over generic blob Content-Types (Azure often sends application/octet-stream).
  const inferredMime = fromHeader || inferMimeFromPathOrUrl(source.url);

  return { buffer, inferredMime };
}

function formatError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as {
      code?: number;
      data?: unknown;
      message?: string;
      rateLimit?: { limit?: number; remaining?: number; reset?: number };
    };

    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (e.code) parts.push(`HTTP ${e.code}`);
    if (e.rateLimit) {
      parts.push(
        `rateLimit remaining=${e.rateLimit.remaining ?? "?"}/${e.rateLimit.limit ?? "?"} reset=${e.rateLimit.reset ?? "?"}`,
      );
    }
    if (e.data !== undefined) {
      parts.push(JSON.stringify(e.data));
    }
    if (parts.length > 0) return parts.join(" | ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function withTwitterError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // Preserve auth errors as-is (token is required only for tool calls)
    if (
      error instanceof Error &&
      error.message.startsWith("Missing access token")
    ) {
      throw error;
    }
    throw new Error(`Twitter API error: ${formatError(error)}`);
  }
}

export async function getMe(): Promise<UserV2> {
  return withTwitterError(async () => {
    const res = await client().v2.me({
      "user.fields": [...DEFAULT_USER_FIELDS],
    });
    return res.data;
  });
}

export async function getUserByUsername(username: string) {
  return withTwitterError(async () => {
    const cleaned = username.replace(/^@/, "");
    const res = await client().v2.userByUsername(cleaned, {
      "user.fields": [...DEFAULT_USER_FIELDS],
    });
    return res.data;
  });
}

export async function getUserById(userId: string) {
  return withTwitterError(async () => {
    const res = await client().v2.user(userId, {
      "user.fields": [...DEFAULT_USER_FIELDS],
    });
    return res.data;
  });
}

export async function getTweet(tweetId: string) {
  return withTwitterError(async () => {
    const res = await client().v2.singleTweet(tweetId, {
      "tweet.fields": [...DEFAULT_TWEET_FIELDS],
      expansions: ["author_id"],
      "user.fields": ["id", "name", "username", "profile_image_url"],
    });
    return {
      tweet: res.data,
      includes: res.includes,
    };
  });
}

export async function getUserTimeline(params: {
  userId: string;
  maxResults?: number;
  paginationToken?: string;
  excludeRetweets?: boolean;
  excludeReplies?: boolean;
}) {
  return withTwitterError(async () => {
    const exclude: Array<"retweets" | "replies"> = [];
    if (params.excludeRetweets) exclude.push("retweets");
    if (params.excludeReplies) exclude.push("replies");

    const res = await client().v2.userTimeline(params.userId, {
      max_results: params.maxResults ?? 10,
      pagination_token: params.paginationToken,
      exclude: exclude.length ? exclude : undefined,
      "tweet.fields": [...DEFAULT_TWEET_FIELDS],
    });

    return {
      tweets: res.data.data ?? [],
      meta: res.data.meta,
    };
  });
}

export async function getUserMentions(params: {
  userId: string;
  maxResults?: number;
  paginationToken?: string;
}) {
  return withTwitterError(async () => {
    const res = await client().v2.userMentionTimeline(params.userId, {
      max_results: params.maxResults ?? 10,
      pagination_token: params.paginationToken,
      "tweet.fields": [...DEFAULT_TWEET_FIELDS],
    });

    return {
      tweets: res.data.data ?? [],
      meta: res.data.meta,
    };
  });
}

export async function searchRecentTweets(params: {
  query: string;
  maxResults?: number;
  nextToken?: string;
}) {
  return withTwitterError(async () => {
    const res = await client().v2.search(params.query, {
      max_results: params.maxResults ?? 10,
      next_token: params.nextToken,
      "tweet.fields": [...DEFAULT_TWEET_FIELDS],
      expansions: ["author_id"],
      "user.fields": ["id", "name", "username"],
    });

    return {
      tweets: res.data.data ?? [],
      includes: res.data.includes,
      meta: res.data.meta,
    };
  });
}

/**
 * Upload media (image, GIF, or video) via X API v2 chunked upload.
 * Requires OAuth 2.0 scope `media.write`. Videos are processed before returning.
 */
export async function uploadMedia(params: {
  source: MediaSource;
  /** MIME type; inferred from path/URL/Content-Type when omitted */
  mediaType?: string;
  /** Defaults from media type (tweet_video / tweet_image / tweet_gif) */
  mediaCategory?: MediaCategory;
}): Promise<{
  media_id: string;
  media_type: string;
  media_category: MediaCategory;
  bytes: number;
}> {
  // Fail fast on missing token before downloading large media.
  getAccessToken();

  let buffer: Buffer;
  let inferredMime: string | undefined;
  try {
    ({ buffer, inferredMime } = await loadMediaBuffer(params.source));
  } catch (error) {
    // Do not label download/IO failures as Twitter API errors (misleading for agents).
    if (
      error instanceof Error &&
      error.message.startsWith("Missing access token")
    ) {
      throw error;
    }
    throw new Error(
      `Media load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const detected = detectFormatFromMagic(buffer);
  const mediaType = normalizeMimeType(
    params.mediaType ?? inferredMime ?? detected.mime ?? "",
  );
  if (!mediaType) {
    throw new Error(
      "Could not determine media_type. Pass media_type explicitly (e.g. video/mp4).",
    );
  }

  if (mediaType.startsWith("audio/")) {
    throw new Error(
      `Cannot upload audio (${mediaType}). X posts only accept images, GIF, or video — not bare audio. ` +
        `Mux the audio into an MP4 video and upload with media_type=video/mp4.`,
    );
  }

  let mediaCategory: MediaCategory;
  try {
    mediaCategory = params.mediaCategory ?? inferMediaCategory(mediaType);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  const sourceHint =
    params.source.kind === "url"
      ? params.source.url.split("?")[0]
      : params.source.kind === "path"
        ? params.source.path
        : undefined;

  assertMediaCompatible({
    buffer,
    mediaType,
    mediaCategory,
    sourceHint,
  });

  return withTwitterError(async () => {
    try {
      const mediaId = await client().v2.uploadMedia(buffer, {
        media_type: mediaType as `${EUploadMimeType}`,
        media_category: mediaCategory,
      });

      return {
        media_id: mediaId,
        media_type: mediaType,
        media_category: mediaCategory,
        bytes: buffer.length,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Library often surfaces "Media processing failed: undefined" with no detail.
      if (msg.includes("Media processing failed")) {
        throw new Error(
          `${msg}. X rejected the file during async processing. ` +
            `For video use H.264 MP4/MOV (not MP3/audio), duration 0.5–140s, max 512MB. ` +
            `Detected local format: ${detected.label}.`,
        );
      }
      throw error;
    }
  });
}

export async function postTweet(params: {
  /** Tweet text; optional when media_ids is provided */
  text?: string;
  replyToTweetId?: string;
  quoteTweetId?: string;
  /** Up to 4 image media IDs, or 1 video / 1 GIF media ID from upload_media */
  mediaIds?: string[];
}): Promise<TweetV2PostTweetResult> {
  return withTwitterError(async () => {
    const text = params.text?.trim() ?? "";
    const mediaIds = params.mediaIds?.filter(Boolean) ?? [];

    if (!text && mediaIds.length === 0) {
      throw new Error("post_tweet requires text and/or media_ids");
    }
    if (mediaIds.length > 4) {
      throw new Error("A tweet can attach at most 4 media items (1 for video/GIF)");
    }

    const payload: {
      text?: string;
      reply?: { in_reply_to_tweet_id: string };
      quote_tweet_id?: string;
      media?: {
        media_ids:
          | [string]
          | [string, string]
          | [string, string, string]
          | [string, string, string, string];
      };
    } = {};

    if (text) {
      payload.text = text;
    }
    if (params.replyToTweetId) {
      payload.reply = { in_reply_to_tweet_id: params.replyToTweetId };
    }
    if (params.quoteTweetId) {
      payload.quote_tweet_id = params.quoteTweetId;
    }
    if (mediaIds.length === 1) {
      payload.media = { media_ids: [mediaIds[0]!] };
    } else if (mediaIds.length === 2) {
      payload.media = { media_ids: [mediaIds[0]!, mediaIds[1]!] };
    } else if (mediaIds.length === 3) {
      payload.media = {
        media_ids: [mediaIds[0]!, mediaIds[1]!, mediaIds[2]!],
      };
    } else if (mediaIds.length === 4) {
      payload.media = {
        media_ids: [mediaIds[0]!, mediaIds[1]!, mediaIds[2]!, mediaIds[3]!],
      };
    }

    return client().v2.tweet(payload);
  });
}

export async function deleteTweet(tweetId: string) {
  return withTwitterError(async () => client().v2.deleteTweet(tweetId));
}

export async function likeTweet(userId: string, tweetId: string) {
  return withTwitterError(async () => client().v2.like(userId, tweetId));
}

export async function unlikeTweet(userId: string, tweetId: string) {
  return withTwitterError(async () => client().v2.unlike(userId, tweetId));
}

export async function retweet(userId: string, tweetId: string) {
  return withTwitterError(async () => client().v2.retweet(userId, tweetId));
}

export async function undoRetweet(userId: string, tweetId: string) {
  return withTwitterError(async () => client().v2.unretweet(userId, tweetId));
}

export async function followUser(sourceUserId: string, targetUserId: string) {
  return withTwitterError(async () =>
    client().v2.follow(sourceUserId, targetUserId),
  );
}

export async function unfollowUser(sourceUserId: string, targetUserId: string) {
  return withTwitterError(async () =>
    client().v2.unfollow(sourceUserId, targetUserId),
  );
}
