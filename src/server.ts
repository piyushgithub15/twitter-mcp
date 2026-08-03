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
    "post_tweet",
    {
      title: "Post tweet",
      description:
        "Create a new tweet/post as the authenticated user. Requires tweet.write scope.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(280)
          .describe("Tweet text (max 280 characters for standard posts)"),
        reply_to_tweet_id: z
          .string()
          .optional()
          .describe("If set, reply to this tweet ID"),
        quote_tweet_id: z
          .string()
          .optional()
          .describe("If set, quote this tweet ID"),
      },
    },
    async (args) => {
      try {
        const result = await twitter.postTweet({
          text: args.text,
          replyToTweetId: args.reply_to_tweet_id,
          quoteTweetId: args.quote_tweet_id,
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
