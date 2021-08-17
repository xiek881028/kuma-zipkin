const axios = require("axios");
const { InetAddress } = require("zipkin");
const { now: zipkinNow } = require("zipkin/src/time");

const isJson = (it) => {
  try {
    JSON.stringify(it);
  } catch (error) {
    return false;
  }
  return true;
};

const queryText = (data, type) => {
  const isJ = isJson(data);
  if (data === undefined || (isJ && !Object.keys(data).length)) return "";
  if (isJ) return `\n${type}: ${JSON.stringify(data)}`;
  return `\n${type}: ${data.toString()}`;
};

const key2LowerCase = (json = {}) => {
  const out = {};
  for (const key in json) {
    if (Object.hasOwnProperty.call(json, key)) {
      out[key.toLowerCase()] = json[key];
    }
  }
  return out;
};

module.exports = (_cfg = {}) => {
  const {
    remoteServiceName,
    ctx: { tracer, logger, ip },
    requestLog,
    responseLog,
    ...other
  } = _cfg;
  const { traceId, spanId, parentSpanId } = tracer?.id ?? {};
  const Axios = axios.create({
    ...other,
  });
  const host = (InetAddress.getLocalAddress() + "").match(
    /\d{0,3}\.\d{0,3}\.\d{0,3}\.\d{0,3}/
  )[0];
  // 请求拦截
  Axios.interceptors.request.use((config) => {
    requestLog && requestLog instanceof Function
      ? requestLog({
          traceId,
          spanId,
          parentSpanId,
          method: config.method.toUpperCase(),
          url: config.url,
          ip,
          host,
          query: config.params,
          data: config.data,
          remoteServiceName,
          config,
        })
      : logger.info(
          `[traceId=${traceId ?? ""}, spanId=${spanId ?? ""}, parentSpanId=${
            parentSpanId.toString() ?? ""
          }]\n${config.method.toUpperCase()} ${
            config.url
          }\norigin: [from ${ip} to ${host}]${queryText(
            config.params,
            "query"
          )}${queryText(
            config.data,
            "data"
          )}\nsource: ${remoteServiceName} 请求\n`
        );
    if (traceId && spanId) {
      config.headers["X-B3-TraceId"] = traceId;
      config.headers["X-B3-SpanId"] = spanId;
      config.headers["X-B3-ParentSpanId"] = parentSpanId.toString();
    }
    config.startTime = zipkinNow();
    return config;
  });
  // 响应拦截
  Axios.interceptors.response.use((config) => {
    const {
      "x-b3-traceid": traceId,
      "x-b3-spanid": spanId,
      "x-b3-parentspanid": parentSpanId,
      "content-type": type,
    } = key2LowerCase(config.headers ?? {});
    const data = queryText(config?.data, "data");
    responseLog && responseLog instanceof Function
      ? responseLog({
          status: config.status,
          traceId,
          spanId,
          parentSpanId,
          method: config.request.method,
          url: config.request.path,
          time: zipkinNow() - config.config.startTime,
          type,
          data,
          remoteServiceName,
          config,
        })
      : logger[
          [200, 204].some((item) => item === config.status) ? "info" : "error"
        ](
          `[traceId=${traceId ?? ""}, spanId=${spanId ?? ""}, parentSpanId=${
            parentSpanId ?? ""
          }]\n${config.request.method} ${config.request.path}\ntime: ${
            (zipkinNow() - config.config.startTime) / 1000
          }ms\nstatus: ${config.status} <${type ?? "undefined"}>${
            data.length > 500
              ? `${data.substr(0, 500)} <data长度为${
                  data.length
                }，只保留500字符>`
              : data
          }\ndst: ${remoteServiceName} 响应\n`
        );
    return config;
  });
  return Axios;
};
