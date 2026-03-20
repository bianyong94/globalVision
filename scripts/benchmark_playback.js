const axios = require('axios')

const BASE = process.env.BENCH_BASE || 'http://127.0.0.1:3010/api'
const TIMEOUT = 20000

const now = () => Date.now()

async function timedGet(url, config = {}) {
  const t0 = now()
  const res = await axios.get(url, { timeout: TIMEOUT, ...config })
  const t1 = now()
  return { res, ms: t1 - t0 }
}

function extractFirstPlayUrl(vodPlayUrl = '') {
  const first = String(vodPlayUrl).split('#')[0] || ''
  const parts = first.split('$')
  return (parts.length > 1 ? parts[1] : parts[0] || '').trim()
}

async function main() {
  const report = { base: BASE, at: new Date().toISOString(), samples: [] }

  const home = await timedGet(`${BASE}/v2/home`)
  const sections = home.res.data?.data?.sections || []
  const all = sections.flatMap((s) => s.data || [])
  const picks = all.slice(0, 3)

  for (const item of picks) {
    const sample = { id: item.id, title: item.title }
    try {
      const detail = await timedGet(`${BASE}/detail/${item.id}`)
      sample.detailMs = detail.ms
      const src = detail.res.data?.data?.sources?.[0]
      const playUrl = extractFirstPlayUrl(src?.vod_play_url || '')
      sample.playUrlType = /m3u8/i.test(playUrl) ? 'm3u8' : 'other'

      if (!playUrl || !/m3u8/i.test(playUrl)) {
        sample.note = 'no m3u8 source'
        report.samples.push(sample)
        continue
      }

      const proxyPlaylistUrl = `${BASE}/video/proxy/playlist.m3u8?url=${encodeURIComponent(playUrl)}`
      const p1 = await timedGet(proxyPlaylistUrl, { responseType: 'text' })
      sample.proxyPlaylistFirstMs = p1.ms
      sample.proxyCacheHeader1 = p1.res.headers['x-video-cache'] || ''

      const p2 = await timedGet(proxyPlaylistUrl, { responseType: 'text' })
      sample.proxyPlaylistSecondMs = p2.ms
      sample.proxyCacheHeader2 = p2.res.headers['x-video-cache'] || ''

      const lines = String(p1.res.data || '').split(/\r?\n/)
      const segs = lines
        .filter((l) => l && !l.startsWith('#'))
        .slice(0, 3)

      sample.segmentMs = []
      for (const seg of segs) {
        const segUrl = /^https?:\/\//i.test(seg)
          ? `${BASE}/video/proxy/segment?url=${encodeURIComponent(seg)}`
          : seg.startsWith('/api/')
            ? `http://127.0.0.1:3010${seg}`
            : `${BASE}${seg}`
        const s = await timedGet(segUrl, { responseType: 'arraybuffer' })
        sample.segmentMs.push(s.ms)
      }

      if (sample.segmentMs.length) {
        const sorted = [...sample.segmentMs].sort((a, b) => a - b)
        sample.segmentP50 = sorted[Math.floor(sorted.length * 0.5)]
        sample.segmentP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      }
    } catch (e) {
      sample.error = e.message
    }
    report.samples.push(sample)
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
