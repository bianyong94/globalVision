const axios = require("axios")
const { sources, PRIORITY_LIST } = require("../config/sources")
const { getAxiosConfig } = require("../utils/httpAgent")

const pickSourceKeys = () => {
  const configuredKeys = Object.keys(sources || {})
  const preferred = PRIORITY_LIST.filter((k) => configuredKeys.includes(k))
  const rest = configuredKeys.filter((k) => !preferred.includes(k))
  return [...preferred, ...rest]
}

const tryFetchFromSource = async (sourceKey, buildParams) => {
  const source = sources[sourceKey]
  if (!source?.url) return null

  const response = await axios.get(source.url, {
    params: buildParams(sourceKey),
    ...getAxiosConfig({ timeout: 9000 }),
  })

  const data = response?.data
  if (!data) return null
  return { sourceKey, sourceName: source.name, data }
}

exports.smartFetch = async (buildParams) => {
  const sourceKeys = pickSourceKeys()

  for (const sourceKey of sourceKeys) {
    try {
      const result = await tryFetchFromSource(sourceKey, buildParams)
      if (result?.data) return result
    } catch (error) {
      continue
    }
  }

  throw new Error("All sources failed")
}
