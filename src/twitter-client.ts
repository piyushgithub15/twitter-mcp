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
  if (lower.endsWith(".mov")) return EUploadMimeType.Mov;
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".gif")) return EUploadMimeType.Gif;
  if (lower.endsWith(".png")) return EUploadMimeType.Png;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return EUploadMimeType.Jpeg;
  if (lower.endsWith(".webp")) return EUploadMimeType.Webp;
  return undefined;
}

function normalizeMimeType(mime: string): string {
  const cleaned = mime.trim().toLowerCase().split(";")[0]?.trim() ?? mime;
  // Common aliases
  if (cleaned === "image/jpg") return EUploadMimeType.Jpeg;
  return cleaned;
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
  const inferredMime =
    (headerMime ? normalizeMimeType(headerMime) : undefined) ||
    inferMimeFromPathOrUrl(source.url);

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

  const mediaType = normalizeMimeType(params.mediaType ?? inferredMime ?? "");
  if (!mediaType) {
    throw new Error(
      "Could not determine media_type. Pass media_type explicitly (e.g. video/mp4).",
    );
  }

  const mediaCategory = params.mediaCategory ?? inferMediaCategory(mediaType);

  return withTwitterError(async () => {
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
