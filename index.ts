/**
 * - the main router builder reads the current directory content
 * - for each item
 *   - if the item is directory then recursively call the build funnction
 *   - else then check if the file suffix is .router.js
 *   - if so then this is router, its default export is router
 *   - you need to use this router with the prefix is the relative folder
 *     name
 *   - the function returns a router
 */

import { HandlerFunction, R } from "$/server/utils/express/index.js";
import zlib from "zlib";
import {
    ChannelHandlerBeforeMounted,
    ChannelHandlerBuilder,
    ChannelHandlerMounted,
} from "../channels_builder/index.js";
import { resolve_ts } from "../common/index.js";
import { DescriptionProps, descriptions_map } from "../routers_helpers/describe/index.js";
import {
    description_suffix_regx,
    directory_alias_suffix_regx,
    middleware_suffix_regx,
    router_suffix_regx,
} from "../routers_helpers/matchers.js";
const env = (await import("$/server/env.js")).env;
const root_paths = (await import("$/server/dynamic_configuration/root_paths.js")).default;
const express = (await import("$/server/utils/express/index.js")).default;
const path = (await import("path")).default;
const url = (await import("url")).default;
const fs = (await import("fs")).default;
const log_util = await import("$/server/utils/log/index.js");
const log = await log_util.local_log_decorator("router_builder", "blue", true, "Info", false);

const directory_routers_alieses = {};
const aliases = [] as any;

export async function get_middlewares_array(router_directory: string): Promise<HandlerFunction[]> {
    const content = fs.readdirSync(router_directory);
    const middlewares = await Promise.all(
        content
            .filter((f) => {
                const file_stats = fs.statSync(path.join(router_directory, f));
                return file_stats.isFile() && !!f.match(middleware_suffix_regx);
            })
            .map(async (f) => {
                const full_path = path.join(router_directory, f);
                return (await import(full_path)).default;
            }),
    );
    return middlewares;
}

export default async function build_router(
    _prefix = "/",
    provided_middlewares: HandlerFunction[] = [],
    router_directory = path.join(root_paths.src_path, env.router.router_directory),
    root = true,
    full_prefix = "/",
) {
    const router = express.Router();
    if (root) {
        router.middlewares = [...provided_middlewares];
    }
    directory_routers_alieses[full_prefix] = router;
    const content = fs.readdirSync(router_directory);
    router.directory_full_path = router_directory;
    for (const item of content) {
        const item_stat = fs.statSync(path.join(router_directory, item));
        if (item_stat.isDirectory()) {
            const sub_router = await build_router(
                item,
                [],
                path.join(router_directory, item),
                false,
                path.join(full_prefix, item),
            );
            const middlewares = await get_middlewares_array(path.join(router_directory, item));
            if (middlewares?.length) {
                router.use(`/${item}`, middlewares, sub_router);
            } else {
                router.use(`/${item}`, sub_router);
            }
        } else {
            const router_match = item.match(router_suffix_regx);
            if (!!router_match) {
                process.env.NODE_ENV !== "test" && console.log("Route", router_directory);
                const router_name = item.slice(0, item.indexOf(router_match[0]));
                const route_full_path = path.join(router_directory, item);
                router.route_full_path = route_full_path;
                if (router_name == "index") {
                    const router_instance = (await import(route_full_path)).default;
                    if (router_instance) {
                        router.use(`/`, router_instance);
                    }
                    const router_description_regx = RegExp(
                        `${router_name}${description_suffix_regx.toString().slice(1, -1)}`,
                    );
                    const router_description_file = content.find((el) => !!el.match(router_description_regx));
                    router_description_file &&
                        router.get(`/describe`, async (request, response, next) => {
                            try {
                                response.sendFile(path.join(router_directory, router_description_file), (error) => {
                                    !!error && next(error);
                                });
                            } catch (error) {
                                next(error);
                            }
                        });
                } else {
                    const sub_router = (await import(path.join(router_directory, item))).default;
                    if (sub_router) {
                        router.use(`/${router_name}`, sub_router);
                    }
                    const router_description_regx = RegExp(
                        `${router_name}${description_suffix_regx.toString().slice(1, -1)}`,
                    );
                    const router_description_file = content.filter((el) => !!el.match(router_description_regx))[0];
                    router_description_file &&
                        router.get(`/${router_name}/describe`, async (request, response, next) => {
                            try {
                                response.sendFile(path.join(router_directory, router_description_file), (error) => {
                                    !!error && next(error);
                                });
                            } catch (error) {
                                next(error);
                            }
                        });
                }
            } else {
                const directory_alias_match = item.match(directory_alias_suffix_regx);
                if (!!directory_alias_match) {
                    aliases.push(async () => {
                        const router_alias = (await import(path.join(router_directory, item))).default;
                        const dir_router = directory_routers_alieses[router_alias];
                        if (!dir_router) {
                            log("Directory alias not found", router_alias);
                            process.exit(1);
                        } else {
                            const router_name = item.slice(0, item.indexOf(directory_alias_match[0]));
                            router.use(`/${router_name}`, dir_router);

                            const full_route = path.join(full_prefix, router_name);
                            const additional_routes: [string, DescriptionProps][] = Object.entries(descriptions_map)
                                .filter(([entry_path, route]) => {
                                    return entry_path.startsWith(router_alias);
                                })
                                .map(([entry_path, route]) => {
                                    entry_path = entry_path.replace(router_alias, full_route);
                                    route = { ...route };
                                    route.full_route_path = entry_path;
                                    return [entry_path, route];
                                });

                            for (const entry of additional_routes) {
                                descriptions_map[entry[0]] = entry[1];
                            }
                        }
                    });
                }
            }
        }
    }

    if (root) {
        await Promise.all(aliases.map((f) => f(router)));
        await process_router_for_channels(router);
    }

    root && log("finished", router_directory);
    return router;
}

export async function get_channel_middlewares_array(current_channels_directory: string): Promise<
    {
        channel_middleware?: ChannelHandlerBuilder;
        channel_mounted?: ChannelHandlerMounted;
        channel_before_mounted?: ChannelHandlerBeforeMounted;
    }[]
> {
    const content = fs.readdirSync(current_channels_directory);
    const middlewares = await Promise.all(
        content
            .filter((f) => {
                const file_stats = fs.statSync(path.join(current_channels_directory, f));
                return file_stats.isFile() && !!f.match(middleware_suffix_regx);
            })
            .map(async (f) => {
                let full_path = path.join(current_channels_directory, f);
                return await import(resolve_ts(full_path));
            }),
    );
    return middlewares;
}

const { handlers: channels_handlers } = await import("$/server/utils/channels_builder/index.js");
async function process_router_for_channels(
    router: R,
    root = true,
    full_prefix = "/",

    provided_middlewares_handlers: HandlerFunction[] = [],

    provided_before_mounted_middlewares: {
        middleware: ChannelHandlerBeforeMounted[];
        path: string;
    }[] = [],
    provided_middlewares: {
        middleware: ChannelHandlerBuilder[];
        path: string;
    }[] = [],
    provided_mounted_middlewares: {
        middleware: ChannelHandlerMounted[];
        path: string;
    }[] = [],
) {
    const middlewares_handlers = [...provided_middlewares_handlers, ...router.middlewares];

    const before_mounted_middlewares = [...provided_before_mounted_middlewares];
    const middlewares = [...provided_middlewares];
    const mounted_middlewares = [...provided_mounted_middlewares];
    if (router.directory_full_path) {
        const loaded_middlewares = await get_channel_middlewares_array(router.directory_full_path);
        for (const middleware of loaded_middlewares || []) {
            if (middleware.channel_before_mounted) {
                const found_before_mounted_middleware = before_mounted_middlewares.find(
                    (pbmm) => pbmm.path == full_prefix,
                );
                if (found_before_mounted_middleware) {
                    found_before_mounted_middleware.middleware.push(middleware.channel_before_mounted);
                } else {
                    before_mounted_middlewares.push({
                        middleware: [middleware.channel_before_mounted],
                        path: full_prefix,
                    });
                }
            }

            if (middleware.channel_middleware) {
                const found_middleware = middlewares.find((pm) => pm.path == full_prefix);
                if (found_middleware) {
                    found_middleware.middleware.push(middleware.channel_middleware);
                } else {
                    middlewares.push({
                        middleware: [middleware.channel_middleware],
                        path: full_prefix,
                    });
                }
            }

            if (middleware.channel_mounted) {
                const found_mounted_middleware = mounted_middlewares.find((pbmm) => pbmm.path == full_prefix);
                if (found_mounted_middleware) {
                    found_mounted_middleware.middleware.push(middleware.channel_mounted);
                } else {
                    mounted_middlewares.push({
                        middleware: [middleware.channel_mounted],
                        path: full_prefix,
                    });
                }
            }
        }
    }

    let channel_mounted: ChannelHandlerMounted | undefined = undefined;
    let channel_before_mounted: ChannelHandlerBeforeMounted | undefined = undefined;
    let channel_handler: ChannelHandlerBuilder | undefined = undefined;
    if (router.route_full_path) {
        const route_file_content: {
            channel_handler?: ChannelHandlerBuilder;
            channel_mounted?: ChannelHandlerMounted;
            channel_before_mounted?: ChannelHandlerBeforeMounted;
        } = (await import(router.route_full_path)) || {};
        channel_mounted = route_file_content?.channel_mounted;
        channel_before_mounted = route_file_content?.channel_before_mounted;
        channel_handler = route_file_content?.channel_handler;
        if (channel_handler) {
            console.log("channel handler in router system", full_prefix, router.route_full_path);
        }
    }

    if (channel_handler) {
        channels_handlers.push({
            before_mounted_middlewares,
            middlewares,
            mounted_middlewares,
            path: full_prefix,
            before_mounted: channel_before_mounted,
            handler: channel_handler,
            mounted: channel_mounted,
        });
    }

    for (const event of Object.values(router.events)) {
        if (event) {
            channels_handlers.push({
                before_mounted_middlewares: [],
                middlewares: [],
                mounted_middlewares: [],
                path: path.join(full_prefix, event.path),
                handler: (socket) => {
                    return [
                        async (body, cb, event_name) => {
                            let status_code = env.response.status_codes.ok;
                            console.log("event", event_name);
                            let cb_called = false;

                            const response = {
                                status(provided_status_code: number) {
                                    status_code = provided_status_code;
                                    return response;
                                },
                                json(response_body: any = {}) {
                                    if (response_body) {
                                        response_body.status_code = status_code;
                                        response_body.status = status_code;
                                    }

                                    const compressed_response_body = zlib.deflateSync(JSON.stringify(response_body), {
                                        level: 9,
                                    });
                                    cb?.(compressed_response_body);
                                    cb_called = true;
                                    return response;
                                },
                                end: () => response,
                            };
                            const request = {
                                body: body,
                                user: socket.data.user,
                                params: body?.provided__params || body,
                                headers: body?.provided__headers || body,
                                query: body?.provided__query || body,
                            };
                            const event_handlers = [...middlewares_handlers, ...event.handlers];
                            for (let i = 0; i < event_handlers.length; i++) {
                                const handler = event_handlers[i];
                                const next = (error: any) => {
                                    if (error) {
                                        error.http_error = true;
                                        throw error;
                                    }
                                };
                                await handler(request as any, response as any, next);
                            }
                            if (!cb_called) {
                                response.json?.({
                                    msg: "ok",
                                });
                            }
                        },
                    ];
                },
            });
        }
    }

    for (const sub_router of Object.values(router.children)) {
        await process_router_for_channels(
            sub_router.router,
            false,
            path.join(full_prefix, sub_router.path || "/"),
            middlewares_handlers,
            before_mounted_middlewares,
            middlewares,
            mounted_middlewares,
        );
    }
}
