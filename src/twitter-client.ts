import {
  TwitterApi,
  EUploadMimeType,
  type TweetV2PostTweetResult,
  type UserV2,
} from "twitter-api-v2";
import { getAccessToken } from "./auth.js";

/** Post media categories only — this MCP does not upload DM/ads/subtitle assets. */
export type MediaCategory = "tweet_image" | "tweet_video" | "tweet_gif";

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

/** X image / GIF caps. Video is capped in-process (X allows 8–16 GB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

const SUPPORTED =
  "JPEG/PNG/WEBP (≤5 MB), GIF (≤15 MB), or H.264 MP4/MOV video";

const SUPPORTED_MIME = new Set<string>([
  EUploadMimeType.Jpeg,
  EUploadMimeType.Png,
  EUploadMimeType.Gif,
  EUploadMimeType.Webp,
  EUploadMimeType.Mp4,
  EUploadMimeType.Mov,
]);

const EXT_MIME: Record<string, string> = {
  jpg: EUploadMimeType.Jpeg,
  jpeg: EUploadMimeType.Jpeg,
  png: EUploadMimeType.Png,
  gif: EUploadMimeType.Gif,
  webp: EUploadMimeType.Webp,
  mp4: EUploadMimeType.Mp4,
  mov: EUploadMimeType.Mov,
  qt: EUploadMimeType.Mov,
};

function client() {
  return new TwitterApi(getAccessToken());
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("ascii");
}

function detectMedia(
  buffer: Buffer,
):
  | { kind: "image" | "video"; mime: string }
  | { kind: "audio"; label: string }
  | { kind: "unsupported"; label: string }
  | { kind: "unknown" } {
  if (buffer.length < 12) return { kind: "unknown" };

  if (buffer[0] === 0x89 && ascii(buffer, 1, 4) === "PNG") {
    return { kind: "image", mime: EUploadMimeType.Png };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: "image", mime: EUploadMimeType.Jpeg };
  }
  const gif = ascii(buffer, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { kind: "image", mime: EUploadMimeType.Gif };
  }
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") {
    return { kind: "image", mime: EUploadMimeType.Webp };
  }
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE") {
    return { kind: "audio", label: "WAV" };
  }
  if (ascii(buffer, 0, 3) === "ID3") {
    return { kind: "audio", label: "MP3" };
  }
  if (ascii(buffer, 0, 4) === "OggS") {
    return { kind: "audio", label: "Ogg" };
  }
  if (ascii(buffer, 4, 8) === "ftyp") {
    const brand = ascii(buffer, 8, 12);
    if (brand === "M4A " || brand === "M4B ") {
      return { kind: "audio", label: "M4A" };
    }
    if (brand === "qt  ") {
      return { kind: "video", mime: EUploadMimeType.Mov };
    }
    return { kind: "video", mime: EUploadMimeType.Mp4 };
  }
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { kind: "unsupported", label: "WebM" };
  }

  return { kind: "unknown" };
}

function cleanMime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mime = value.trim().toLowerCase().split(";")[0]?.trim();
  if (
    !mime ||
    mime === "application/octet-stream" ||
    mime === "binary/octet-stream" ||
    mime === "application/binary"
  ) {
    return undefined;
  }
  if (mime === "image/jpg") return EUploadMimeType.Jpeg;
  return mime;
}

function mimeFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = path.match(/\.([a-z0-9]+)$/)?.[1];
    return ext ? EXT_MIME[ext] : undefined;
  } catch {
    return undefined;
  }
}

function categoryFor(mime: string): MediaCategory {
  if (mime === EUploadMimeType.Gif) return "tweet_gif";
  if (mime.startsWith("video/")) return "tweet_video";
  return "tweet_image";
}

function maxBytesFor(category: MediaCategory): number {
  if (category === "tweet_image") return MAX_IMAGE_BYTES;
  if (category === "tweet_gif") return MAX_GIF_BYTES;
  return MAX_VIDEO_BYTES;
}

function resolveMedia(
  buffer: Buffer,
  url: string,
  contentType?: string,
): { mediaType: string; mediaCategory: MediaCategory } {
  const detected = detectMedia(buffer);

  if (detected.kind === "audio") {
    throw new Error(
      `X does not accept audio files (${detected.label}). ${SUPPORTED}. Mux audio into an MP4 (H.264 + AAC) first.`,
    );
  }
  if (detected.kind === "unsupported") {
    throw new Error(
      `${detected.label} is not a reliable post format. Convert to H.264 MP4/MOV. ${SUPPORTED}.`,
    );
  }

  const mime =
    detected.kind === "unknown"
      ? (cleanMime(contentType) ?? mimeFromUrl(url))
      : detected.mime;

  if (mime === "video/webm" || mime === "video/mp2t") {
    throw new Error(
      `${mime} is not a reliable post format. Convert to H.264 MP4/MOV. ${SUPPORTED}.`,
    );
  }

  if (!mime || !SUPPORTED_MIME.has(mime)) {
    throw new Error(
      `Unsupported media${mime ? ` (${mime})` : ""} from ${url}. ${SUPPORTED}.`,
    );
  }

  const mediaCategory = categoryFor(mime);
  const max = maxBytesFor(mediaCategory);
  if (buffer.length > max) {
    throw new Error(
      `File is ${buffer.length} bytes; ${mediaCategory} max is ${max} bytes. ${SUPPORTED}.`,
    );
  }

  return { mediaType: mime, mediaCategory };
}

async function downloadMedia(url: string): Promise<{
  buffer: Buffer;
  contentType?: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid media_url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("media_url must be an http(s) URL");
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: { Accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download media_url (HTTP ${response.status} ${response.statusText})`,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_VIDEO_BYTES) {
    throw new Error(
      `Media exceeds max download size of ${MAX_VIDEO_BYTES} bytes (Content-Length ${contentLength})`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("media_url downloaded empty body");
  }
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(
      `Media exceeds max download size of ${MAX_VIDEO_BYTES} bytes (${buffer.length} bytes)`,
    );
  }

  return {
    buffer,
    contentType: response.headers.get("content-type") ?? undefined,
  };
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
 * Download a URL and upload it via X API v2 chunked upload.
 * Requires OAuth 2.0 scope `media.write`. Videos are processed before returning.
 */
export async function uploadMedia(mediaUrl: string): Promise<{
  media_id: string;
  media_type: string;
  media_category: MediaCategory;
  bytes: number;
}> {
  getAccessToken();

  let buffer: Buffer;
  let contentType: string | undefined;
  try {
    ({ buffer, contentType } = await downloadMedia(mediaUrl));
  } catch (error) {
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

  const { mediaType, mediaCategory } = resolveMedia(
    buffer,
    mediaUrl,
    contentType,
  );

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
      if (msg.includes("Media processing failed")) {
        throw new Error(
          `${msg}. X rejected the file during processing. ${SUPPORTED}. Video must be H.264 + AAC, ≥0.5s.`,
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
