import React, { useState, useEffect, useRef, FormEvent, FC, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Content } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MODEL_NAME = 'gemini-2.5-pro';
const INITIAL_SYSTEM_INSTRUCTION = "You are an expert-level AI assistant. Your task is to provide a comprehensive, accurate, and well-reasoned initial response to the user's query. Aim for clarity and depth. Note: Your response is an intermediate step for other AI agents and will not be shown to the user. Be concise and focus on core information without unnecessary verbosity.";
const REFINEMENT_SYSTEM_INSTRUCTION = "You are a reflective AI agent. Your primary task is to find flaws. Critically analyze your previous response and the responses from other AI agents. Focus specifically on identifying factual inaccuracies, logical fallacies, omissions, or any other weaknesses. Your goal is to generate a new, revised response that corrects these specific errors and is free from the flaws you have identified. Note: This refined response is for a final synthesizer agent, not the user, so be direct and prioritize accuracy over conversational style.";
const SYNTHESIZER_SYSTEM_INSTRUCTION = "You are a master synthesizer AI. Your PRIMARY GOAL is to write the final, complete response to the user's query. You will be given the user's query and four refined responses from other AI agents. Your task is to analyze these responses—identifying their strengths to incorporate and their flaws to discard. Use this analysis to construct the single best possible answer for the user. Do not just critique the other agents; your output should BE the final, polished response.";


interface Message {
  role: 'user' | 'model';
  parts: { text: string }[];
}

const CodeBlock: FC<{ children?: ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const textToCopy = String(children).replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <div className="code-block-wrapper">
      <pre><code>{children}</code></pre>
      <button onClick={handleCopy} className="copy-button" aria-label="Copy code">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
          {copied ? (
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
          ) : (
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-5zm0 16H8V7h11v14z"/>
          )}
        </svg>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
};

const LoadingIndicator: FC<{ status: string; time: number }> = ({ status, time }) => (
  <div className="loading-animation">
    <div className="loading-header">
      <span className="loading-status">{status}</span>
      <span className="timer-display">{(time / 1000).toFixed(1)}s</span>
    </div>
    <div className={`progress-bars-container ${status.startsWith('Initializing') ? 'initial' : 'refining'}`}>
      <div className="progress-bar"></div>
      <div className="progress-bar"></div>
      <div className="progress-bar"></div>
      <div className="progress-bar"></div>
    </div>
  </div>
);

const App: FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [timer, setTimer] = useState<number>(0);
  const messageListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages, isLoading]);
  
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      interval = setInterval(() => {
        setTimer(prevTime => prevTime + 100);
      }, 100);
    } else {
      setTimer(0);
    }
    return () => clearInterval(interval);
  }, [isLoading]);


  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const userInput = formData.get('userInput') as string;
    event.currentTarget.reset();
    if (!userInput.trim()) return;

    const userMessage: Message = { role: 'user', parts: [{ text: userInput }] };
    const currentMessages = [...messages, userMessage];
    setMessages(currentMessages);
    setIsLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      
      const mainChatHistory: Content[] = currentMessages.slice(0, -1).map(msg => ({
        role: msg.role,
        parts: msg.parts,
      }));
      const currentUserTurn: Content = { role: 'user', parts: [{ text: userInput }] };

      // STEP 1: Initial Responses (Concurrent)
      setLoadingStatus('Initializing agents...');
      const initialAgentPromises = Array(4).fill(0).map(() => 
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: [...mainChatHistory, currentUserTurn],
          config: { systemInstruction: INITIAL_SYSTEM_INSTRUCTION },
        })
      );
      const initialResponses = await Promise.all(initialAgentPromises);
      const initialAnswers = initialResponses.map(res => res.text);

      // STEP 2: Refined Responses (Concurrent)
      setLoadingStatus('Refining answers...');
      const refinementAgentPromises = initialAnswers.map((initialAnswer, index) => {
        const otherAnswers = initialAnswers.filter((_, i) => i !== index);
        const refinementContext = `My initial response was: "${initialAnswer}". The other agents responded with: 1. "${otherAnswers[0]}" 2. "${otherAnswers[1]}" 3. "${otherAnswers[2]}". Based on this context, critically re-evaluate and provide a new, improved response to the original query.`;
        
        const refinementTurn: Content = { role: 'user', parts: [{ text: `${userInput}\n\n---INTERNAL CONTEXT---\n${refinementContext}` }] };
        
        return ai.models.generateContent({ 
          model: MODEL_NAME, 
          contents: [...mainChatHistory, refinementTurn],
          config: { systemInstruction: REFINEMENT_SYSTEM_INSTRUCTION },
        });
      });
      const refinedResponses = await Promise.all(refinementAgentPromises);
      const refinedAnswers = refinedResponses.map(res => res.text);

      // STEP 3: Final Synthesis (Non-Streaming)
      setLoadingStatus('Synthesizing final response...');
      const synthesizerContext = `Here are the four refined responses to the user's query. Your task is to synthesize them into the best single, final answer.\n\nRefined Response 1:\n"${refinedAnswers[0]}"\n\nRefined Response 2:\n"${refinedAnswers[1]}"\n\nRefined Response 3:\n"${refinedAnswers[2]}"\n\nRefined Response 4:\n"${refinedAnswers[3]}"`;
      const synthesizerTurn: Content = { role: 'user', parts: [{ text: `${userInput}\n\n---INTERNAL CONTEXT---\n${synthesizerContext}` }] };

      const finalResult = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [...mainChatHistory, synthesizerTurn],
        config: { systemInstruction: SYNTHESIZER_SYSTEM_INSTRUCTION },
      });
      
      setIsLoading(false);

      const finalResponseText = finalResult.text;
      const finalMessage: Message = { role: 'model', parts: [{ text: finalResponseText }] };
      setMessages(prev => [...prev, finalMessage]);

    } catch (error) {
      console.error('Error sending message to agents:', error);
      setIsLoading(false);
      setMessages(prev => [...prev, { role: 'model', parts: [{ text: 'Sorry, I encountered an error. Please try again.' }] }]);
    }
  };

  return (
    <div className="chat-container">
      <header>
        <h1>Multi-Agent Chat</h1>
      </header>
      <div className="message-list" ref={messageListRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
             {msg.role === 'model' && <span className="agent-label">Synthesizer Agent</span>}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code(props) {
                  const {children, className, ...rest} = props
                  return <CodeBlock>{String(children)}</CodeBlock>
                }
              }}
            >
              {msg.parts[0].text}
            </ReactMarkdown>
          </div>
        ))}
        {isLoading && <LoadingIndicator status={loadingStatus} time={timer} />}
      </div>
      <form className="input-area" onSubmit={handleSubmit}>
        <input
          type="text"
          name="userInput"
          placeholder="Ask the agents..."
          aria-label="User input"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading} aria-label="Send message">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
        </button>
      </form>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);