const {
  option: { Some, None },
  Instrumentation,
  InetAddress,
  Tracer,
  ConsoleRecorder,
  ExplicitContext,
} = require("zipkin");

const parseRequestUrl = require("zipkin/src/parseUrl");
const { now, hrtime } = require("zipkin/src/time");
const isJson = (it) => {
  try {
    JSON.stringify(it);
  } catch (error) {
    return false;
  }
  return true;
};
const isFunction = (it) => {
  return Object.prototype.toString.call(it) == "[object Function]";
};
const ctxImpl = new ExplicitContext();
const recorder = new ConsoleRecorder();
const tracer = new Tracer({
  recorder,
  ctxImpl,
  localServiceName: "",
});

class KumaInstrumentation extends Instrumentation.HttpServer {
  constructor(props) {
    super(props);
  }
  recordRequest(method, requestUrl, readHeader) {
    this._createIdFromHeaders(readHeader).ifPresent((id) =>
      this.tracer.setId(id)
    );
    const { id } = this.tracer;
    const { path } = parseRequestUrl(requestUrl);
    const host = ((this.host || InetAddress.getLocalAddress()) + "").match(
      /\d{0,3}\.\d{0,3}\.\d{0,3}\.\d{0,3}/
    )[0];

    return { id, path, method: method.toUpperCase(), host };
  }
}

/**
 * @brief 基于zipkin-js二次封装的koa插件
 * @param {string} serviceName 服务名
 * @param {number} port 端口
 * @param {Object} console 日志输出工具
 * @param {Array} ignore 需要忽略的日志
 * @param {Boolean} header 是否在浏览器头写入id
 * @return {ZipkinKoaMiddleware}
 */
module.exports = function koaMiddleware({
  serviceName = "",
  port = 0,
  console = global.console,
  ignore = [],
  requestLog,
  responseLog,
  setHead = true,
}) {
  const instrumentation = new KumaInstrumentation({
    tracer,
    serviceName,
    port,
  });

  /**
   * @method
   * @typedef {function} ZipkinKoaMiddleware
   * @param {Object} ctx
   * @param {function()} next
   */
  return function zipkinKoaMiddleware(ctx, next) {
    function readHeader(header) {
      const val = ctx.request.headers[header.toLowerCase()];
      if (val != null) {
        return new Some(val);
      } else {
        return None;
      }
    }
    return tracer.scoped(() => {
      const _method = ctx.request.method.toUpperCase();
      const { id, path, method, host } = instrumentation.recordRequest(
        _method,
        ctx.request.href,
        readHeader
      );
      const _ignore = (Array.isArray(ignore) ? ignore : [ignore]).some((item) =>
        isFunction(item)
          ? item({ path, method, ip: ctx.ip, host })
          : ((path.match(item) ?? [])[0] ?? "").length
      );
      id.startTime = now();
      id.startTimeMicro = now(id.startTime, hrtime());

      Object.defineProperty(ctx, "tracer", {
        configurable: false,
        get: () => tracer,
      });

      Object.defineProperty(ctx.request, "_trace_id", {
        configurable: false,
        get: () => id,
      });
      Object.defineProperty(ctx.request, "_trace_path", {
        configurable: false,
        get: () => path,
      });
      Object.defineProperty(ctx.request, "_trace_method", {
        configurable: false,
        get: () => method,
      });
      Object.defineProperty(ctx.request, "_trace_host", {
        configurable: false,
        get: () => host,
      });
      const queryText = (data, type) => {
        const isJ = isJson(data);
        if (data === undefined || (isJ && !Object.keys(data).length)) return "";
        if (isJ) return `\n${type}: ${JSON.stringify(data)}`;
        return `\n${type}: ${data.toString()}`;
      };
      const { traceId, spanId, parentSpanId } = id;

      !_ignore &&
        console.info(
          requestLog && requestLog instanceof Function
            ? requestLog({
                traceId,
                spanId,
                parentSpanId,
                method,
                url: path,
                ip: ctx.ip,
                host,
                query: ctx.query,
                data: ctx.request.body,
                params: ctx.params,
                serviceName,
                ctx,
                id,
              })
            : `[${serviceName},${traceId},${spanId},${parentSpanId}]\n${(
                method + ""
              ).toUpperCase()} ${path}\norigin: [from ${
                ctx.ip
              } to ${host}]${queryText(ctx.query, "query")}${queryText(
                ctx.request.body,
                "data"
              )}${queryText(ctx.params, "params")}\nsource: 客户端 请求\n`
        );

      const recordResponse = () => {
        const resBody = ["application/json", "text/plain"].some(
          (item) => item === ctx.type
        )
          ? `data: ${JSON.stringify(ctx.body)}\n`
          : "";
        tracer.letId(id, () => {
          // support koa-route and koa-router
          const matchedPath = ctx.routePath || ctx._matchedRoute || ctx.path;
          !_ignore &&
            console[
              [200, 204].some((item) => item === ctx.status) ? "info" : "error"
            ](
              responseLog && responseLog instanceof Function
                ? responseLog({
                    status: ctx.status,
                    traceId,
                    spanId,
                    parentSpanId,
                    method,
                    url: matchedPath,
                    time: now() - id.startTime,
                    type: ctx.type,
                    data: ctx.body,
                    serviceName,
                    ctx,
                    id,
                  })
                : `[${serviceName},${traceId},${spanId},${parentSpanId}]\n${(
                    method + ""
                  ).toUpperCase()} ${matchedPath}\ntime: ${
                    (now() - id.startTime) / 1000
                  }ms\nstatus: ${ctx.status} <${
                    ctx.type
                  }>\n${resBody}dst: 客户端 响应\n`
            );
          if (setHead) {
            ctx.set("X-B3-TraceId", traceId);
            ctx.set("X-B3-SpanId", spanId);
            ctx.set("X-B3-ParentSpanId", parentSpanId);
          }
        });
      };

      ctx.console = {};
      ["error", "info", "warn", "debug"].map((item) => {
        ctx.console[item] = (...args) => {
          ctx.logger[item](
            `[traceId=${traceId ?? ""}, spanId=${spanId ?? ""}, parentSpanId=${
              parentSpanId.toString() ?? ""
            }]\n`,
            ...args
          );
        };
      });
      // 错误处理
      ctx.errorFn = (error, message, status = 500, print = true) => {
        print && ctx.console.error(error);
        ctx.status = error.isAxiosError ? error.response.status : status;
        ctx.body = {
          message:
            message ||
            (error.isAxiosError
              ? error.response?.data?.message
              : error.message || "系统错误"),
        };
      };

      return next().then(recordResponse).catch(recordResponse);
    });
  };
};
