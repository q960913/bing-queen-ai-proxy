import {type NextRequest, NextResponse} from 'next/server';
import {
    GoogleGenAI,
    createUserContent,
    createPartFromUri,
    type GenerationConfig,
    type Content,
    type Part,
} from "@google/genai";
import {randomUUID} from "node:crypto";

// 在 route.ts 的顶部

// [新增] 定义支持的多媒体 MIME 类型
type SupportedMimeType =
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/heic'
    | 'image/heif'
    | 'audio/wav'
    | 'audio/mp3'
    | 'audio/aiff'
    | 'audio/aac'
    | 'audio/ogg'
    | 'audio/flac'
    | 'video/mp4'
    | 'video/mpeg'
    | 'video/mov'
    | 'video/avi'
    | 'video/x-flv'
    | 'video/3gpp'
    | 'video/webm'
    | 'video/wmv'
    | 'application/pdf';

/**
 * 定义从若依后端接收的请求体结构，确保类型安全。
 */
interface BackendRequestBody {
    contents: {
        // [修改] 扩展 type 类型
        type: 'text' | 'image' | 'audio' | 'video' | 'pdf';
        data: string;
        // [修改] 让 mimeType 使用我们定义的类型
        mimeType?: SupportedMimeType;
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

        // [核心修改] 将后端传来的 contents 数组，转换为 Gemini SDK 需要的 Part[] 格式
        const currentContentParts: Part[] = [];
        for (const content of body.contents) {
            switch (content.type) {
                case 'text':
                    currentContentParts.push({text: content.data});
                    break;

                case 'image':
                case 'audio':
                case 'video':
                case 'pdf':
                    // [核心] 增加对 mimeType 和 data 的健壮性检查
                    if (!content.mimeType || !content.data) {
                        return NextResponse.json({
                            error: `Invalid request: content of type '${content.type}' must have mimeType and data.`
                        }, {status: 400});
                    }
                    const fileBuffer = await fetch(content.data)
                        .then((response) => response.arrayBuffer());

                    const fileBlob = new Blob([fileBuffer], {type: content.mimeType as SupportedMimeType});

                    const file = await ai.files.upload({
                        file: fileBlob,
                        config: {
                            displayName: randomUUID(),
                        },
                    });
                    if (file.name == null) {
                        file.name = randomUUID();
                    }
                    // Wait for the file to be processed.
                    let getFile = await ai.files.get({name: file.name});
                    while (getFile.state === 'PROCESSING') {
                        getFile = await ai.files.get({name: file.name});
                        await new Promise((resolve) => {
                            setTimeout(resolve, 5000);
                        });
                    }
                    if (file.uri && file.mimeType) {
                        currentContentParts.push(
                            createPartFromUri(file.uri, file.mimeType)
                        );
                    }
                    break;

                default:
                    // 如果传来了一个我们不认识的类型，返回错误
                    return NextResponse.json({
                        error: `Invalid request: unsupported content type.`
                    }, {status: 400});
            }
        }

// 如果处理完后，parts 数组是空的，说明有问题
        if (currentContentParts.length === 0) {
            return NextResponse.json({error: 'Invalid request: `contents` array resulted in no processable parts.'}, {status: 400});
        }


// --- 5. 核心逻辑：根据是否存在 history，智能切换模式并获取流 ---
        let resultStream;

// [核心修改] 多媒体内容通常用于单轮对话，如果请求中包含多媒体，我们强制走单轮模式
        const hasMultimedia = body.contents.some(c => c.type !== 'text');

        if (body.history && body.history.length > 0 && !hasMultimedia) {

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
                model: "gemini-2.5-flash",
                contents: createUserContent(
                    currentContentParts
                ),
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
                        const sseChunk = `data: ${JSON.stringify({text: chunkText})}\n\n`;
                        controller.enqueue(new TextEncoder().encode(sseChunk));
                    }
                }

                // [简化] 暂时不处理最后的 token 信息，以解决 .response 不存在的错误
                // 等流式文本跑通后，再来研究如何从流中聚合最终响应
                const finalEvent = {event: 'end', data: {finishReason: 'STOP'}};
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