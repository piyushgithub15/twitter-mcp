import { TwitterApi, type TweetV2PostTweetResult, type UserV2 } from "twitter-api-v2";
import { getAccessToken } from "./auth.js";

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

function client() {
  return new TwitterApi(getAccessToken());
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

export async function postTweet(params: {
  text: string;
  replyToTweetId?: string;
  quoteTweetId?: string;
}): Promise<TweetV2PostTweetResult> {
  return withTwitterError(async () => {
    const payload: {
      text: string;
      reply?: { in_reply_to_tweet_id: string };
      quote_tweet_id?: string;
    } = { text: params.text };

    if (params.replyToTweetId) {
      payload.reply = { in_reply_to_tweet_id: params.replyToTweetId };
    }
    if (params.quoteTweetId) {
      payload.quote_tweet_id = params.quoteTweetId;
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
