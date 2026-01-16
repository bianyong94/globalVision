const http = require("http")
const https = require("https")
const { HttpsProxyAgent } = require("https-proxy-agent")

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

const getAxiosConfig = () => {
  const config = { timeout: 6000, httpAgent, httpsAgent }
  if (process.env.PROXY_URL) {
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL)
  }
  return config
}

module.exports = { getAxiosConfig }
