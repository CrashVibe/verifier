import {} from "koishi-plugin-cron";
import { Context } from "koishi";
import { Config } from ".";
import { CachedRequest, Handlers, RequestHandler, SessionProcess } from "./types";
import { handleRequest } from "./handler";

export async function applycron(ctx: Context, config: Config) {
    const { cronExpression, batchSize } = config;

    ctx.cron(cronExpression, async () => {
        ctx.logger.info("开始处理缓存的请求...");

        try {
            const requests: SessionProcess[] = [];
            for await (const [key, value] of ctx.cache.entries("verifier:requests")) {
                if (value?.status === "pending") {
                    ctx.bots.map((bot) => {
                        if (value.data.selfId === bot.selfId) {
                            requests.push({
                                ...value,
                                session: bot.session(value.data)
                            });
                        }
                    });
                }
            }

            const requestsByBot = new Map<string, SessionProcess[]>();
            for (const req of requests) {
                const botId = req.session.bot.selfId;
                const botReqs = requestsByBot.get(botId) ?? [];
                if (!requestsByBot.has(botId)) requestsByBot.set(botId, botReqs);
                botReqs.push(req);
            }

            ctx.logger.info(`找到 ${requests.length} 个待处理请求，分布在 ${requestsByBot.size} 个机器人账号中`);

            for (const [botId, botRequests] of requestsByBot) {
                const toProcess = botRequests.sort((a, b) => a.timestamp - b.timestamp).slice(0, batchSize);

                ctx.logger.info(
                    `机器人 ${botId}: 待处理 ${botRequests.length} 个请求，本次处理 ${toProcess.length} 个`
                );

                for (const req of toProcess) {
                    const key = `${req.type}:${req.session.messageId}`;
                    req.status = "processing";
                    await ctx.cache.set("verifier:requests", key, {
                        ...req,
                        data: JSON.parse(JSON.stringify(req.session))
                    });

                    try {
                        await processRequest(ctx, req, config);
                        req.status = "processed";
                        await ctx.cache.set("verifier:requests", key, {
                            ...req,
                            data: JSON.parse(JSON.stringify(req.session))
                        });
                        ctx.logger.info(`已处理请求: ${key} (机器人: ${botId})`);
                    } catch (error) {
                        ctx.logger.error(`处理请求失败 ${key} (机器人: ${botId}): ${error}`);
                        req.status = "pending";
                        await ctx.cache.set("verifier:requests", key, {
                            ...req,
                            data: JSON.parse(JSON.stringify(req.session))
                        });
                    }
                }
            }
        } catch (error) {
            ctx.logger.error(`定时任务执行失败: ${error}`);
        }
    });
}

async function processRequest(ctx: Context, req: SessionProcess, config: Config) {
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
