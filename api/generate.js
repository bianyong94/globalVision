import axios from "axios"

// -------------------------------------------------------------------
// 【真实世界的函数】 - 调用 Replicate API
// 你需要去 Replicate.com 注册并获取你的 API Token
// -------------------------------------------------------------------
const REPLICATE_API_TOKEN = "YOUR_REPLICATE_API_TOKEN" // 把它放在 .env 文件中更安全
const SVD_MODEL_VERSION =
  "3f0457e4619daac51203dedb472816fd4af51d315e93b19d52b3925103a932ab"

// 延迟函数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callReplicateAPI(imageUrl, prompt) {
  // 步骤 1: 启动生成任务
  const startResponse = await axios.post(
    "https://api.replicate.com/v1/predictions",
    {
      version: SVD_MODEL_VERSION,
      input: {
        input_image: imageUrl, // Replicate 需要一个公开可访问的图片 URL
        motion_bucket_id: 127, // 运动幅度，值越高动态越大
        cond_aug: 0.02,
        // prompt: prompt, // SVD 目前对 prompt 支持有限，主要依赖图片本身
      },
    },
    {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  )

  let prediction = startResponse.data
  const predictionId = prediction.id

  // 步骤 2: 轮询任务状态
  while (prediction.status !== "succeeded" && prediction.status !== "failed") {
    await sleep(2000) // 每 2 秒查询一次
    const pollResponse = await axios.get(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      {
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
        },
      }
    )
    prediction = pollResponse.data
  }

  if (prediction.status === "failed") {
    throw new Error("AI generation failed: " + prediction.error)
  }

  // 步骤 3: 返回结果
  return prediction.output // 这是一个视频 URL
}

// -------------------------------------------------------------------
// 【用于本地测试的模拟函数】 - 无需 API Key 即可运行
// -------------------------------------------------------------------
export async function generateVideoFromImage(imageFile, prompt) {
  console.log("启动模拟生成...", { prompt })

  // 模拟图片上传过程 (在真实应用中，你需要上传到 S3 或类似服务)
  const imageUrl = URL.createObjectURL(imageFile)
  console.log("模拟图片 URL:", imageUrl)

  // 模拟 AI 处理延迟
  await sleep(5000) // 假装处理了 5 秒

  // 模拟成功返回一个视频 URL (这是一个占位符视频)
  console.log("模拟生成成功！")
  return "https://replicate.delivery/pbxt/J1g9g26W4Q51pT2eIdej5Jz2rOa36Tf5Yq5fJ6B3bXfXIn0iA/output.mp4"

  // 如果想测试真实 API，请取消下面的注释
  // return await callReplicateAPI(imageUrl, prompt);
}
