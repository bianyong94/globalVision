const http = require("http")
const https = require("https")
const { HttpsProxyAgent } = require("https-proxy-agent")

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

const getAxiosConfig = (options = {}) => {
  const timeoutMsRaw = options?.timeout ?? process.env.AXIOS_TIMEOUT_MS
  const timeoutMs = Number.parseInt(String(timeoutMsRaw || ""), 10)
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000

  const config = { timeout, httpAgent, httpsAgent }
  if (process.env.PROXY_URL) {
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL)
  }
  return config
}

module.exports = { getAxiosConfig }
