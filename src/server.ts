import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as twitter from "./twitter-client.js";

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

/**
 * Create a fresh MCP server instance with Twitter tools registered.
 * Stateless mode: construct one of these per HTTP request.
 */
export function createTwitterMcpServer(): McpServer {
  const server = new McpServer({
    name: "twitter-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_me",
    {
      title: "Get authenticated user",
      description:
        "Return the Twitter/X user associated with the OAuth access token.",
      inputSchema: {},
    },
    async () => {
      try {
        const me = await twitter.getMe();
        return textResult(me);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_by_username",
    {
      title: "Get user by username",
      description: "Look up a Twitter/X user by username (handle without @).",
      inputSchema: {
        username: z
          .string()
          .min(1)
          .max(100)
          .describe("Username / handle (with or without leading @)"),
      },
    },
    async ({ username }) => {
      try {
        const user = await twitter.getUserByUsername(username);
        return textResult(user);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_by_id",
    {
      title: "Get user by ID",
      description: "Look up a Twitter/X user by numeric user ID.",
      inputSchema: {
        user_id: z.string().min(1).describe("Twitter/X user ID"),
      },
    },
    async ({ user_id }) => {
      try {
        const user = await twitter.getUserById(user_id);
        return textResult(user);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_tweet",
    {
      title: "Get tweet",
      description: "Fetch a single tweet/post by ID, including author expansion.",
      inputSchema: {
        tweet_id: z.string().min(1).describe("Tweet / post ID"),
      },
    },
    async ({ tweet_id }) => {
      try {
        const result = await twitter.getTweet(tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_timeline",
    {
      title: "Get user timeline",
      description: "Fetch recent tweets posted by a user.",
      inputSchema: {
        user_id: z.string().min(1).describe("Twitter/X user ID"),
        max_results: z
          .number()
          .int()
          .min(5)
          .max(100)
          .optional()
          .describe("Number of tweets to return (5-100, default 10)"),
        pagination_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
        exclude_retweets: z
          .boolean()
          .optional()
          .describe("Exclude retweets from results"),
        exclude_replies: z
          .boolean()
          .optional()
          .describe("Exclude replies from results"),
      },
    },
    async (args) => {
      try {
        const result = await twitter.getUserTimeline({
          userId: args.user_id,
          maxResults: args.max_results,
          paginationToken: args.pagination_token,
          excludeRetweets: args.exclude_retweets,
          excludeReplies: args.exclude_replies,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_user_mentions",
    {
      title: "Get user mentions",
      description: "Fetch tweets that mention a given user.",
      inputSchema: {
        user_id: z.string().min(1).describe("Twitter/X user ID"),
        max_results: z
          .number()
          .int()
          .min(5)
          .max(100)
          .optional()
          .describe("Number of mentions to return (5-100, default 10)"),
        pagination_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
      },
    },
    async (args) => {
      try {
        const result = await twitter.getUserMentions({
          userId: args.user_id,
          maxResults: args.max_results,
          paginationToken: args.pagination_token,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_recent_tweets",
    {
      title: "Search recent tweets",
      description:
        "Search recent tweets (last 7 days) using Twitter/X query operators.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(512)
          .describe("Search query (e.g. from:user lang:en -is:retweet)"),
        max_results: z
          .number()
          .int()
          .min(10)
          .max(100)
          .optional()
          .describe("Number of results (10-100, default 10)"),
        next_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
      },
    },
    async (args) => {
      try {
        const result = await twitter.searchRecentTweets({
          query: args.query,
          maxResults: args.max_results,
          nextToken: args.next_token,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "upload_media",
    {
      title: "Upload media",
      description:
        "Upload an image, GIF, or video to X/Twitter (chunked API v2). Returns a media_id to pass to post_tweet. " +
        "Videos (mp4/mov) are fully processed before the media_id is returned. " +
        "Provide exactly one of media_url, media_path, or media_base64. " +
        "Requires OAuth scopes: media.write (and tweet.write to post).",
      inputSchema: {
        media_url: z
          .string()
          .url()
          .optional()
          .describe("HTTP(S) URL of the media file to download and upload"),
        media_path: z
          .string()
          .min(1)
          .optional()
          .describe("Local filesystem path on the MCP server host"),
        media_base64: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Base64-encoded media (raw or data: URL). Prefer media_url for large videos.",
          ),
        media_type: z
          .enum([
            "video/mp4",
            "video/quicktime",
            "video/webm",
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
          ])
          .optional()
          .describe(
            "MIME type. Inferred from path/URL/Content-Type when omitted; required for bare base64.",
          ),
        media_category: z
          .enum([
            "tweet_video",
            "tweet_image",
            "tweet_gif",
            "amplify_video",
            "dm_video",
            "dm_image",
            "dm_gif",
            "subtitles",
          ])
          .optional()
          .describe(
            "X media category. Defaults from media_type (tweet_video for videos).",
          ),
      },
    },
    async (args) => {
      try {
        const sources = [
          args.media_url ? 1 : 0,
          args.media_path ? 1 : 0,
          args.media_base64 ? 1 : 0,
        ].reduce((a, b) => a + b, 0);
        if (sources !== 1) {
          throw new Error(
            "Provide exactly one of media_url, media_path, or media_base64",
          );
        }

        let source: twitter.MediaSource;
        if (args.media_url) {
          source = { kind: "url", url: args.media_url };
        } else if (args.media_path) {
          source = { kind: "path", path: args.media_path };
        } else {
          source = { kind: "base64", data: args.media_base64! };
        }

        const result = await twitter.uploadMedia({
          source,
          mediaType: args.media_type,
          mediaCategory: args.media_category,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "post_tweet",
    {
      title: "Post tweet",
      description:
        "Create a new tweet/post as the authenticated user. " +
        "Supports text, optional reply/quote, and media (images/video) via media_ids from upload_media. " +
        "Attach 1 video or GIF, or up to 4 images. Requires tweet.write; media needs prior upload_media (media.write).",
      inputSchema: {
        text: z
          .string()
          .max(280)
          .optional()
          .describe(
            "Tweet text (max 280 characters). Optional if media_ids is provided.",
          ),
        reply_to_tweet_id: z
          .string()
          .optional()
          .describe("If set, reply to this tweet ID"),
        quote_tweet_id: z
          .string()
          .optional()
          .describe("If set, quote this tweet ID"),
        media_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(4)
          .optional()
          .describe(
            "Media IDs from upload_media. Max 4 images, or 1 video, or 1 GIF.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await twitter.postTweet({
          text: args.text,
          replyToTweetId: args.reply_to_tweet_id,
          quoteTweetId: args.quote_tweet_id,
          mediaIds: args.media_ids,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_tweet",
    {
      title: "Delete tweet",
      description: "Delete a tweet owned by the authenticated user.",
      inputSchema: {
        tweet_id: z.string().min(1).describe("Tweet ID to delete"),
      },
    },
    async ({ tweet_id }) => {
      try {
        const result = await twitter.deleteTweet(tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "like_tweet",
    {
      title: "Like tweet",
      description: "Like a tweet as the authenticated user.",
      inputSchema: {
        user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        tweet_id: z.string().min(1).describe("Tweet ID to like"),
      },
    },
    async ({ user_id, tweet_id }) => {
      try {
        const result = await twitter.likeTweet(user_id, tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "unlike_tweet",
    {
      title: "Unlike tweet",
      description: "Remove a like from a tweet as the authenticated user.",
      inputSchema: {
        user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        tweet_id: z.string().min(1).describe("Tweet ID to unlike"),
      },
    },
    async ({ user_id, tweet_id }) => {
      try {
        const result = await twitter.unlikeTweet(user_id, tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "retweet",
    {
      title: "Retweet",
      description: "Retweet a post as the authenticated user.",
      inputSchema: {
        user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        tweet_id: z.string().min(1).describe("Tweet ID to retweet"),
      },
    },
    async ({ user_id, tweet_id }) => {
      try {
        const result = await twitter.retweet(user_id, tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undo_retweet",
    {
      title: "Undo retweet",
      description: "Undo a retweet as the authenticated user.",
      inputSchema: {
        user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        tweet_id: z.string().min(1).describe("Tweet ID to un-retweet"),
      },
    },
    async ({ user_id, tweet_id }) => {
      try {
        const result = await twitter.undoRetweet(user_id, tweet_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "follow_user",
    {
      title: "Follow user",
      description: "Follow a user as the authenticated account.",
      inputSchema: {
        source_user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        target_user_id: z.string().min(1).describe("User ID to follow"),
      },
    },
    async ({ source_user_id, target_user_id }) => {
      try {
        const result = await twitter.followUser(source_user_id, target_user_id);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "unfollow_user",
    {
      title: "Unfollow user",
      description: "Unfollow a user as the authenticated account.",
      inputSchema: {
        source_user_id: z
          .string()
          .min(1)
          .describe("Authenticated user's ID (from get_me)"),
        target_user_id: z.string().min(1).describe("User ID to unfollow"),
      },
    },
    async ({ source_user_id, target_user_id }) => {
      try {
        const result = await twitter.unfollowUser(
          source_user_id,
          target_user_id,
        );
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
