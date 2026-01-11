import {} from "koishi-plugin-cron";
import { Context } from "koishi";
import { Config } from ".";
import { CachedRequest, Handlers, RequestHandler } from "./types";
import { handleRequest } from "./handler";

export async function applycron(ctx: Context, config: Config) {
    const { cronExpression, batchSize } = config;

    ctx.cron(cronExpression, async () => {
        ctx.logger.info("开始处理缓存的请求...");

        try {
            const requests: CachedRequest[] = [];
            for await (const [key, value] of ctx.cache.entries("verifier:requests")) {
                const cached = value;
                if (cached && cached.status === "pending") {
                    requests.push(cached);
                }
            }

            requests.sort((a, b) => a.timestamp - b.timestamp); // 时间排序
            const toProcess = requests.slice(0, batchSize);

            ctx.logger.info(`找到 ${requests.length} 个待处理请求，本次处理 ${toProcess.length} 个`);

            // 处理请求
            for (const req of toProcess) {
                const key = `${req.type}:${req.session.messageId}`;

                req.status = "processing"; // 标记为处理中
                await ctx.cache.set("verifier:requests", key, req);

                try {
                    await processRequest(ctx, req, config);
                    // 标记为已处理
                    req.status = "processed";
                    await ctx.cache.set("verifier:requests", key, req);

                    ctx.logger.info(`已处理请求: ${key}`);
                } catch (error) {
                    ctx.logger.error(`处理请求失败 ${key}: ${error}`);
                    // 失败则恢复为待处理状态
                    req.status = "pending";
                    await ctx.cache.set("verifier:requests", key, req);
                }
            }
        } catch (error) {
            ctx.logger.error(`定时任务执行失败: ${error}`);
        }
    });
}

async function processRequest(ctx: Context, req: CachedRequest, config: Config) {
    const { onFriendRequest, onGuildRequest, onGuildMemberRequest } = config;

    if (!req.session.bot) {
        throw new Error(`找不到 bot: ${req.session.platform}:${req.session.selfId}`);
    }

    const handlers: Handlers = {
        friend: { handler: onFriendRequest, prefer: true, isChannel: false, method: "handleFriendRequest" },
        guild: { handler: onGuildRequest, prefer: false, isChannel: true, method: "handleGuildRequest" },
        "guild-member": {
            handler: onGuildMemberRequest,
            prefer: false,
            isChannel: false,
            method: "handleGuildMemberRequest"
        }
    };

    const { handler, prefer, isChannel, method } = handlers[req.type];
    if (!handler) {
        throw new Error(`未配置处理器: ${req.type}`);
    }
    if (!req.session.messageId) {
        throw new Error(`找不到消息 ID: ${req.type}`);
    }
    const result = await handleRequest(handler, req.session, prefer, isChannel);
    if (result) await req.session.bot[method](req.session.messageId, ...result);
}
