import { Awaitable, Context, Schema, Session } from "koishi";

type RequestHandler = number | GeneralHandler;
type GeneralHandler = string | boolean | ((session: Session) => Awaitable<string | boolean | void>);
type ApprovalResponse = [approve: boolean, comment?: string];

interface CachedRequest {
    type: "friend" | "guild" | "guild-member";
    timestamp: number;
    status: "pending" | "processing" | "processed";
    session: Session;
}

type Handlers = Record<
    "friend" | "guild" | "guild-member",
    {
        handler: RequestHandler | undefined;
        prefer: boolean;
        isChannel: boolean;
        method: "handleFriendRequest" | "handleGuildRequest" | "handleGuildMemberRequest";
    }
>;

export { RequestHandler, GeneralHandler, ApprovalResponse, CachedRequest, Handlers };
