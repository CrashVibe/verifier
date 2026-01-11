import { Context, Schema, Session } from "koishi";
import type { CachedRequest, Handlers, RequestHandler, SessionProcess } from "./types";
import { handleRequest } from "./handler";
import { applycron } from "./scheduler";

export const inject = ["cache", "cron"];

const RequestHandler = Schema.union([
    Schema.const(undefined).description("无操作"),
    Schema.const(true).description("全部通过"),
    Schema.const(false).description("全部拒绝"),
    Schema.natural().description("权限等级").default(0),
    Schema.string().hidden(),
    Schema.function().hidden()
]);

export const name = "verifier";

export interface Config {
    onFriendRequest?: RequestHandler;
    onGuildMemberRequest?: RequestHandler;
    onGuildRequest?: RequestHandler;
    cacheTypes: Array<"friend" | "guild-member" | "guild">;
    cacheDuration: number;
    cronExpression: string;
    batchSize: number;
}

const cacheTypesSchema = Schema.array(
    Schema.union([
        Schema.const("friend" as const).description("好友请求"),
        Schema.const("guild-member" as const).description("入群申请"),
        Schema.const("guild" as const).description("入群邀请")
    ])
)
    .default([])
    .description("需要延迟同意的请求类型");

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        onFriendRequest: RequestHandler.description("如何响应好友请求？"),
        onGuildMemberRequest: RequestHandler.description("如何响应入群申请？"),
        onGuildRequest: RequestHandler.description("如何响应入群邀请？"),
        cacheTypes: cacheTypesSchema
    }),
    Schema.object({
        cacheDuration: Schema.number()
            .default(30 * 24 * 60 * 60 * 1000) // 30 days
            .description("缓存时间（毫秒）"),
        cronExpression: Schema.string().default("0 */6 * * *").description("定时表达式"),
        batchSize: Schema.number().default(3).min(1).description("每次处理数量")
    })
]) as Schema<Config>;

export async function apply(ctx: Context, config: Config) {
    if (config.cacheTypes && config.cacheTypes.length > 0) {
        applycron(ctx, config);
    }

    ctx.on("friend-request", (session) => {
        handleEvent(ctx, session, config, "friend");
    });

    ctx.on("guild-request", (session) => {
        handleEvent(ctx, session, config, "guild");
    });

    ctx.on("guild-member-request", (session) => {
        handleEvent(ctx, session, config, "guild-member");
    });

    ctx.command("验证器状态").action(async () => {
        const friendRequests: SessionProcess[] = [];
        const guildRequests: SessionProcess[] = [];
        const guildMemberRequests: SessionProcess[] = [];
        const allKeys: string[] = [];

        await ctx.cache.forEach("verifier:requests", async (value, key) => {
            allKeys.push(key);
            ctx.bots.forEach((bot) => {
                if (value.data?.selfId !== bot.selfId) return;
                const target =
                    value.type === "friend"
                        ? friendRequests
                        : value.type === "guild"
                        ? guildRequests
                        : value.type === "guild-member"
                        ? guildMemberRequests
                        : undefined;
                if (target) {
                    target.push({
                        ...value,
                        session: bot.session(value.data)
                    });
                }
            });
        });

        const formatTimestamp = (timestamp: number) => {
            const date = new Date(timestamp);
            return date.toLocaleString("zh-CN");
        };

        const formatDuration = (ms: number) => {
            const days = Math.floor(ms / (24 * 60 * 60 * 1000));
            const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
            return `${days}天${hours}小时${minutes}分钟`;
        };

        const formatRequestList = (requests: SessionProcess[]) => {
            if (requests.length === 0) return "无";
            return requests
                .map((req, index) => {
                    const session = req.session;
                    const age = Date.now() - req.timestamp;
                    return `  ${index + 1}. ${session.userId || session.guildId || "未知"} | 状态: ${
                        req.status
                    } | 时间: ${formatTimestamp(req.timestamp)} | 已等待: ${formatDuration(age)}`;
                })
                .join("\n");
        };

        const output = [
            "=== 验证器状态 ===",
            "",
            "【缓存统计】",
            `总请求数: ${allKeys.length}`,
            `好友请求: ${friendRequests.length} 个`,
            `入群邀请: ${guildRequests.length} 个`,
            `入群申请: ${guildMemberRequests.length} 个`,
            "",
            "【好友请求详情】",
            formatRequestList(friendRequests),
            "",
            "【入群邀请详情】",
            formatRequestList(guildRequests),
            "",
            "【入群申请详情】",
            formatRequestList(guildMemberRequests),
            "",
            `更新时间: ${formatTimestamp(Date.now())}`
        ];

        return output.join("\n");
    });
}

export async function handleEvent(
    ctx: Context,
    session: Session,
    config: Config,
    type: "friend" | "guild" | "guild-member"
) {
    const handlers: Handlers = {
        friend: { handler: config.onFriendRequest, prefer: true, isChannel: false, method: "handleFriendRequest" },
        guild: { handler: config.onGuildRequest, prefer: false, isChannel: true, method: "handleGuildRequest" },
        "guild-member": {
            handler: config.onGuildMemberRequest,
            prefer: false,
            isChannel: false,
            method: "handleGuildMemberRequest"
        }
    };
    const { handler, prefer, isChannel, method } = handlers[type];
    if (!handler) return;
    if (config.cacheTypes && config.cacheTypes.includes(type)) {
        await cacheRequest(ctx, session, type, config.cacheDuration);
        return;
    }
    const result = await handleRequest(handler, session, prefer, isChannel);
    if (result && session.messageId) session.bot[method](session.messageId, ...result);
}

async function cacheRequest(
    ctx: Context,
    session: Session,
    type: "friend" | "guild" | "guild-member",
    maxAge?: number
) {
    const key = `${type}:${session.messageId}`;
    const cachedData: CachedRequest = {
        type,
        timestamp: Date.now(),
        status: "pending" as const,
        data: JSON.parse(JSON.stringify(session))
    };
    await ctx.cache.set("verifier:requests", key, cachedData, maxAge);
}
