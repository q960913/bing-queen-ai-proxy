import { NextRequest, NextResponse } from 'next/server';
// 导入最新的 Gemini SDK
import { GoogleGenAI } from "@google/genai";

/**
 * 处理 POST 请求的函数
 * 这是我们 API 路由的核心
 */
export async function POST(request: NextRequest) {
    try {
        // 1. 从你的若依后端发来的请求中解析出 JSON 数据
        const body = await request.json();
        const prompt = body.prompt;

        // 2. 验证输入，如果 prompt 不存在，则返回一个明确的错误
        if (!prompt) {
            return NextResponse.json({ error: 'Prompt is required in the request body' }, { status: 400 });
        }

        // 3. 从 Vercel 的环境变量中安全地获取 API Key
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            // 如果在服务器上找不到 API Key，返回一个服务器错误
            console.error('GEMINI_API_KEY is not set in environment variables.');
            return NextResponse.json({ error: 'API Key is not configured on the server' }, { status: 500 });
        }

        // 4. 使用最新的 SDK 初始化 GoogleGenAI 客户端
        const ai = new GoogleGenAI({ apiKey });

        // 5. 调用 Gemini API 来生成内容
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash", // 使用性价比高的 Flash 模型
            contents: [{ role: "user", parts: [{ text: prompt }] }],
        });

        // 6. 从响应中直接获取纯文本结果
        const text = response.text;

        // 7. 将结果作为 JSON 返回给你的若依后端
        return NextResponse.json({ text });

    } catch (error) {
        // 捕获所有可能发生的错误（网络错误、API 错误等）
        console.error('Error in Gemini API route:', error);
        // 返回一个通用的服务器错误信息，并将具体错误打印在 Vercel 的日志中供你调试
// 修正后的、更健壮的代码
        if (error instanceof Error) {
            // 如果它确实是一个 Error 对象，我们就可以安全地访问它的 message 属性
            return NextResponse.json({ error: error.message }, { status: 500 });
        } else {
            // 如果它不是 Error 对象，我们把它转换成字符串来显示
            return NextResponse.json({ error: String(error) }, { status: 500 });
        }    }
}

/**
 * (可选但强烈推荐) 健康检查端点
 * 让你能通过浏览器直接访问 https://proxy.bingbingqueen.top/api/chat 来确认服务是否在线
 */
export async function GET() {
    const status = {
        message: "Bing Queen AI Proxy is online and ready to receive POST requests.",
        status: "OK",
        timestamp: new Date().toISOString(),
        sdk: "@google/genai"
    };
    return NextResponse.json(status);
}