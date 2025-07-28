import {type NextRequest, NextResponse} from 'next/server';
import {
    GoogleGenAI,
    type GenerationConfig,
    type Content,
    type Part,
} from "@google/genai";

/**
 * 定义从若依后端接收的请求体结构，确保类型安全。
 */
interface BackendRequestBody {
    contents: {
        type: 'text' | 'image_base64';
        data: string;
        mimeType?: string; // image_base64 时需要
    }[];
    history?: Content[]; // 可选的、符合 Gemini SDK 格式的多轮对话历史
    config?: GenerationConfig & { systemInstruction?: string }; // 可选的模型配置，并扩展支持 systemInstruction
    model?: string; // 可选，允许后端动态指定模型
}

/**
 * 这是我们唯一的、全能的 POST 代理函数
 */
export async function POST(request: NextRequest) {
    try {
        // --- 1. 安全验证 ---
        // 从 Vercel 环境变量中读取我们自己设置的共享密钥
        const proxySecretKey = process.env.PROXY_SECRET_KEY;
        const receivedAuthHeader = request.headers.get('Authorization');

        // 如果密钥未设置或不匹配，则拒绝访问
        if (!proxySecretKey || receivedAuthHeader !== `Bearer ${proxySecretKey}`) {
            return NextResponse.json({error: 'Unauthorized: Invalid or missing proxy secret key'}, {status: 401});
        }

        // --- 2. 解析和验证请求体 ---
        const body: BackendRequestBody = await request.json();

        if (!body.contents || !Array.isArray(body.contents) || body.contents.length === 0) {
            return NextResponse.json({error: 'Invalid request: `contents` array is required and cannot be empty.'}, {status: 400});
        }

        // --- 3. 初始化 Gemini SDK ---
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('FATAL: GEMINI_API_KEY environment variable is not set on the server.');
            return NextResponse.json({error: 'API Key is not configured on the server'}, {status: 500});
        }
        const ai = new GoogleGenAI({apiKey});

        // --- 4. 准备 API 调用参数 ---
        const modelName = body.model || "gemini-2.5-flash"; // 默认使用高性价比的 Flash 模型

        // 构造 generationConfig，并将 systemInstruction 移入正确的位置
        const generationConfig: GenerationConfig = {
            ...body.config,
        };

        // 将前端传来的 contents 数组，转换为 Gemini SDK 需要的 Part[] 格式
        const currentContentParts: Part[] = body.contents.map(content => {
            if (content.type === 'image_base64' && content.mimeType && content.data) {
                return {inlineData: {mimeType: content.mimeType, data: content.data}};
            }
            return {text: content.data};
        });

        // --- 5. 核心逻辑：根据是否存在 history，智能切换模式并获取流 ---
        let resultStream;
        if (body.history && body.history.length > 0) {

            // **多轮对话模式**
            const chat = ai.chats.create({
                model: modelName,
                config: generationConfig,
                history: body.history,
            });
            // 在 if (body.history && ...) 块内
            const userPromptText = body.contents[0].data; // 直接取出文本
            // [修正]
            resultStream = await chat.sendMessageStream({
                message: userPromptText
            });
        } else {
            // **单轮对话模式，用于多媒体**
            resultStream = await ai.models.generateContentStream({
                model: modelName,
                contents: [{ role: "user", parts: currentContentParts }], // <-- [修正] 把 parts 数组包在 content 对象里
                config: generationConfig
            });


        }

        // --- 6. 将 Gemini 的响应流，实时转发给若依后端 ---
        const stream = new ReadableStream({
            async start(controller) {
                // [修正] 直接使用 resultStream 进行迭代，不再访问 .stream
                if (!resultStream) {
                    controller.close();
                    return;
                }

                // 逐块读取 Gemini 的流
                for await (const chunk of resultStream) {
                    const chunkText = chunk.text;
                    if (chunkText) {
                        const sseChunk = `data: ${JSON.stringify({ text: chunkText })}\n\n`;
                        controller.enqueue(new TextEncoder().encode(sseChunk));
                    }
                }

                // [简化] 暂时不处理最后的 token 信息，以解决 .response 不存在的错误
                // 等流式文本跑通后，再来研究如何从流中聚合最终响应
                const finalEvent = { event: 'end', data: { finishReason: 'STOP' } };
                const finalChunk = `event: ${finalEvent.event}\ndata: ${JSON.stringify(finalEvent.data)}\n\n`;
                controller.enqueue(new TextEncoder().encode(finalChunk));

                controller.close();
            }
        });


        // 返回一个标准的 SSE 响应
        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error) {
        let errorMessage = 'An internal server error occurred.';
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        console.error('Error in proxy route:', error);
        return NextResponse.json({error: errorMessage}, {status: 500});
    }
}

/**
 * 健康检查的 GET 请求
 */
export async function GET() {
    const status = {
        message: "Bing Queen AI Proxy is online and ready for POST requests.",
        status: "OK",
        timestamp: new Date().toISOString(),
        sdk: "@google/genai"
    };
    return NextResponse.json(status);
}