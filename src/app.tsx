import { useEffect, useState, useRef, useCallback, use } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import type { Message } from "@ai-sdk/react";
import { APPROVAL } from "./shared";
import type { tools } from "./tools";
import ReactMarkdown from "react-markdown";
import { BacklinkRenderer } from "@/components/chat/BacklinkRenderer";

// Component imports
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { TextArea } from "@/components/input/TextArea";
import { Avatar } from "@/components/avatar/Avatar";
import { Toggle } from "@/components/toggle/Toggle";
import { Tooltip } from "@/components/tooltip/Tooltip";
import { MemosPanel } from "@/components/memos/MemosPanel";
import { FragmentsPanel } from "@/components/fragments/FragmentsPanel";
import { FragmentViewer } from "@/components/fragments/FragmentViewer";
import { ThreadsPanel } from "@/components/threads/ThreadsPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";

// Icon imports
import {
  Bug,
  Moon,
  PaperPlaneRight,
  Robot,
  Sun,
  Trash,
  Note,
  Files,
  Gear,
} from "@phosphor-icons/react";
import { useRealtimeSession } from "./hooks/useRealtimeSession";

// List of tools that require human confirmation
const toolsRequiringConfirmation: (keyof typeof tools)[] = [
  "getWeatherInformation",
];

export default function Chat() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const savedTheme = localStorage.getItem("theme");
    return (savedTheme as "dark" | "light") || "dark";
  });

  // Model constants
  const OPENAI_MODEL_NAME = "gpt-4.1-2025-04-14";
  const ANTHROPIC_MODEL_NAME = "claude-sonnet-4-20250514";
  const [currentModel, setCurrentModel] = useState<
    typeof OPENAI_MODEL_NAME | typeof ANTHROPIC_MODEL_NAME
  >(OPENAI_MODEL_NAME);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [modelSwitchLoading, setModelSwitchLoading] = useState(false);
  const [modelSwitchError, setModelSwitchError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showMemos, setShowMemos] = useState(false);
  const [showFragments, setShowFragments] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewingFragment, setViewingFragment] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"threads" | "chat" | "fragments">(
    "threads"
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    scrollToBottom();
    const fragmentSlug = sessionStorage.getItem("openFragmentSlug");
    if (fragmentSlug) {
      setViewingFragment(fragmentSlug);
      sessionStorage.removeItem("openFragmentSlug");
    }
  }, [scrollToBottom]);

  const handleNavigateToFragment = (slug: string) => {
    setViewingFragment(slug);
  };

  const handleCloseFragmentViewer = () => {
    setViewingFragment(null);
  };

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
  };

  const handleModelChange = async (
    modelName: typeof OPENAI_MODEL_NAME | typeof ANTHROPIC_MODEL_NAME
  ) => {
    setModelSwitchLoading(true);
    setModelSwitchError(null);

    try {
      const response = await fetch("/agents/chat/default/set-model", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ modelName }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setCurrentModel(modelName);
      } else {
        const errorMessage = result.error || "Failed to change model";
        setModelSwitchError(errorMessage);
        console.error("Failed to change model:", errorMessage);
      }
    } catch (error) {
      setModelSwitchError("Network error when changing model");
      console.error("Error changing model:", error);
    } finally {
      setModelSwitchLoading(false);
    }
  };

  useEffect(() => {
    const fetchModelAndKeyStatus = async () => {
      try {
        const modelResponse = await fetch("/agents/chat/default/get-model");
        if (modelResponse.ok) {
          const data = await modelResponse.json();
          if (data.currentModel) {
            setCurrentModel(data.currentModel);
          }
        }

        const keyResponse = await fetch(
          "/agents/chat/default/check-anthropic-key"
        );
        if (keyResponse.ok) {
          const data = await keyResponse.json();
          setHasAnthropicKey(data.success);
        }
      } catch (error) {
        console.error("Error fetching model or key status:", error);
      }
    };

    fetchModelAndKeyStatus();
  }, []);

  const agent = useAgent({
    agent: "chat",
  });

  const {
    messages: agentMessages,
    input: agentInput,
    handleInputChange: handleAgentInputChange,
    handleSubmit: handleAgentSubmit,
    addToolResult,
    clearHistory,
  } = useAgentChat({
    agent,
    maxSteps: 5,
  });

  useEffect(() => {
    agentMessages.length > 0 && scrollToBottom();
  }, [agentMessages, scrollToBottom]);

  const pendingToolCallConfirmation = agentMessages.some((m: Message) =>
    m.parts?.some(
      (part) =>
        part.type === "tool-invocation" &&
        part.toolInvocation.state === "call" &&
        toolsRequiringConfirmation.includes(
          part.toolInvocation.toolName as keyof typeof tools
        )
    )
  );

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const {
    startSession,
    stopSession,
    sendTextMessage,
    isSessionActive,
    events,
    transcription,
  } = useRealtimeSession();

  useEffect(() => {
    if (transcription.length > 0 && isSessionActive) {
      const syntheticEvent = {
        target: { value: transcription.join(" ") },
      } as React.ChangeEvent<HTMLTextAreaElement>;

      handleAgentInputChange(syntheticEvent);
    }
  }, [transcription, isSessionActive, handleAgentInputChange]);

  return (
    <div className="h-[100vh] w-full p-4 flex justify-center items-center bg-fixed overflow-hidden">
      <HasOpenAIKey />
      <div className="h-[calc(100vh-2rem)] w-full mx-auto max-w-lg flex flex-col shadow-xl rounded-md overflow-hidden relative border border-neutral-300 dark:border-neutral-800">
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center gap-3 sticky top-0 z-10">
          <div className="flex items-center justify-center h-8 w-8">
            <svg
              width="28px"
              height="28px"
              className="text-[#F48120]"
              data-icon="agents"
            >
              <title>Cloudflare Agents</title>
              <symbol id="ai:local:agents" viewBox="0 0 80 79">
                <path
                  fill="currentColor"
                  d="M69.3 39.7c-3.1 0-5.8 2.1-6.7 5H48.3V34h4.6l4.5-2.5c1.1.8 2.5 1.2 3.9 1.2 3.8 0 7-3.1 7-7s-3.1-7-7-7-7 3.1-7 7c0 .9.2 1.8.5 2.6L51.9 30h-3.5V18.8h-.1c-1.3-1-2.9-1.6-4.5-1.9h-.2c-1.9-.3-3.9-.1-5.8.6-.4.1-.8.3-1.2.5h-.1c-.1.1-.2.1-.3.2-1.7 1-3 2.4-4 4 0 .1-.1.2-.1.2l-.3.6c0 .1-.1.1-.1.2v.1h-.6c-2.9 0-5.7 1.2-7.7 3.2-2.1 2-3.2 4.8-3.2 7.7 0 .7.1 1.4.2 2.1-1.3.9-2.4 2.1-3.2 3.5s-1.2 2.9-1.4 4.5c-.1 1.6.1 3.2.7 4.7s1.5 2.9 2.6 4c-.8 1.8-1.2 3.7-1.1 5.6 0 1.9.5 3.8 1.4 5.6s2.1 3.2 3.6 4.4c1.3 1 2.7 1.7 4.3 2.2v-.1q2.25.75 4.8.6h.1c0 .1.1.1.1.1.9 1.7 2.3 3 4 4 .1.1.2.1.3.2h.1c.4.2.8.4 1.2.5 1.4.6 3 .8 4.5.7.4 0 .8-.1 1.3-.1h.1c1.6-.3 3.1-.9 4.5-1.9V62.9h3.5l3.1 1.7c-.3.8-.5 1.7-.5 2.6 0 3.8 3.1 7 7 7s7-3.1 7-7-3.1-7-7-7c-1.5 0-2.8.5-3.9 1.2l-4.6-2.5h-4.6V48.7h14.3c.9 2.9 3.5 5 6.7 5 3.8 0 7-3.1 7-7s-3.1-7-7-7m-7.9-16.9c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3m0 41.4c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3M44.3 72c-.4.2-.7.3-1.1.3-.2 0-.4.1-.5.1h-.2c-.9.1-1.7 0-2.6-.3-1-.3-1.9-.9-2.7-1.7-.7-.8-1.3-1.7-1.6-2.7l-.3-1.5v-.7q0-.75.3-1.5c.1-.2.1-.4.2-.7s.3-.6.5-.9c0-.1.1-.1.1-.2.1-.1.1-.2.2-.3s.1-.2.2-.3c0 0 0-.1.1-.1l.6-.6-2.7-3.5c-1.3 1.1-2.3 2.4-2.9 3.9-.2.4-.4.9-.5 1.3v.1c-.1.2-.1.4-.1.6-.3 1.1-.4 2.3-.3 3.4-.3 0-.7 0-1-.1-2.2-.4-4.2-1.5-5.5-3.2-1.4-1.7-2-3.9-1.8-6.1q.15-1.2.6-2.4l.3-.6c.1-.2.2-.4.3-.5 0 0 0-.1.1-.1.4-.7.9-1.3 1.5-1.9 1.6-1.5 3.8-2.3 6-2.3q1.05 0 2.1.3v-4.5c-.7-.1-1.4-.2-2.1-.2-1.8 0-3.5.4-5.2 1.1-.7.3-1.3.6-1.9 1s-1.1.8-1.7 1.3c-.3.2-.5.5-.8.8-.6-.8-1-1.6-1.3-2.6-.2-1-.2-2 0-2.9.2-1 .6-1.9 1.3-2.6.6-.8 1.4-1.4 2.3-1.8l1.8-.9-.7-1.9c-.4-1-.5-2.1-.4-3.1s.5-2.1 1.1-2.9q.9-1.35 2.4-2.1c.9-.5 2-.8 3-.7.5 0 1 .1 1.5.2 1 .2 1.8.7 2.6 1.3s1.4 1.4 1.8 2.3l4.1-1.5c-.9-2-2.3-3.7-4.2-4.9q-.6-.3-.9-.6c.4-.7 1-1.4 1.6-1.9.8-.7 1.8-1.1 2.9-1.3.9-.2 1.7-.1 2.6 0 .4.1.7.2 1.1.3V72zm25-22.3c-1.6 0-3-1.3-3-3 0-1.6 1.3-3 3-3s3 1.3 3 3c0 1.6-1.3 3-3 3"
                />
              </symbol>
              <use href="#ai:local:agents" />
            </svg>
          </div>

          <div className="flex-1">
            <h2 className="font-semibold text-base">Samantabhadra</h2>
          </div>

          <div className="flex items-center gap-2 mr-2">
            <Bug size={16} />
            <Toggle
              toggled={showDebug}
              aria-label="Toggle debug mode"
              onClick={() => setShowDebug((prev) => !prev)}
            />
          </div>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={() => {
              setShowMemos((prev) => !prev);
              setShowFragments(false);
            }}
            aria-label="Toggle memos panel"
          >
            <Note size={20} />
          </Button>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
          >
            <Gear size={20} />
          </Button>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={() => {
              setShowFragments((prev) => !prev);
              setShowMemos(false);
            }}
            aria-label="Toggle fragments panel"
          >
            <Files size={20} />
          </Button>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          </Button>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={clearHistory}
          >
            <Trash size={20} />
          </Button>
        </div>

        {/* Fragment Viewer */}
        {viewingFragment && (
          <FragmentViewer
            slug={viewingFragment}
            onClose={handleCloseFragmentViewer}
            onNavigateToFragment={handleNavigateToFragment}
          />
        )}

        {/* Settings Panel */}
        {showSettings && (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            currentModel={currentModel}
            hasAnthropicKey={hasAnthropicKey}
            onModelChange={handleModelChange}
            modelSwitchLoading={modelSwitchLoading}
            modelSwitchError={modelSwitchError}
          />
        )}

        {/* Legacy panels or main tabbed interface */}
        {showMemos ? (
          <MemosPanel onClose={() => setShowMemos(false)} />
        ) : showFragments ? (
          <FragmentsPanel onClose={() => setShowFragments(false)} />
        ) : (
          <>
            {/* Tab Navigation */}
            <div className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
              <div className="flex">
                <button
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === "threads"
                      ? "border-[#F48120] text-[#F48120]"
                      : "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }`}
                  onClick={() => setActiveTab("threads")}
                >
                  Threads
                </button>
                <button
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === "chat"
                      ? "border-[#F48120] text-[#F48120]"
                      : "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }`}
                  onClick={() => setActiveTab("chat")}
                >
                  Chat
                </button>
                <button
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === "fragments"
                      ? "border-[#F48120] text-[#F48120]"
                      : "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }`}
                  onClick={() => setActiveTab("fragments")}
                >
                  Fragments
                </button>
              </div>
            </div>

            {/* Tab Content */}
            {activeTab === "threads" && (
              <ThreadsPanel onClose={() => setActiveTab("chat")} />
            )}

            {activeTab === "fragments" && (
              <div className="flex-1">
                <FragmentsPanel onClose={() => setActiveTab("threads")} />
              </div>
            )}

            {activeTab === "chat" && (
              <>
                {/* Chat Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-24 max-h-[calc(100vh-10rem)]">
                  {agentMessages.length === 0 && (
                    <div className="h-full flex items-center justify-center">
                      <Card className="p-6 max-w-md mx-auto bg-neutral-100 dark:bg-neutral-900">
                        <div className="text-center space-y-4">
                          <div className="bg-[#F48120]/10 text-[#F48120] rounded-full p-3 inline-flex">
                            <Robot size={24} />
                          </div>
                          <h3 className="font-semibold text-lg">Chat</h3>
                          <p className="text-muted-foreground text-sm">
                            Traditional chat interface with the assistant.
                          </p>
                          <p className="text-muted-foreground text-sm">
                            Try the Threads tab for a more social experience!
                          </p>
                        </div>
                      </Card>
                    </div>
                  )}

                  {agentMessages.map((m: Message, index) => {
                    const isUser = m.role === "user";
                    const showAvatar =
                      index === 0 || agentMessages[index - 1]?.role !== m.role;

                    return (
                      <div key={m.id}>
                        {showDebug && (
                          <pre className="text-xs text-muted-foreground overflow-scroll">
                            {JSON.stringify(m, null, 2)}
                          </pre>
                        )}
                        <div
                          className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`flex gap-2 max-w-[85%] ${isUser ? "flex-row-reverse" : "flex-row"}`}
                          >
                            {showAvatar && !isUser ? (
                              <Avatar username={"AI"} />
                            ) : (
                              !isUser && <div className="w-8" />
                            )}

                            <div>
                              <div>
                                {m.parts?.map((part, i) => {
                                  if (part.type === "text") {
                                    return (
                                      <div key={i}>
                                        <Card
                                          className={`p-3 rounded-md bg-neutral-100 dark:bg-neutral-900 ${
                                            isUser
                                              ? "rounded-br-none"
                                              : "rounded-bl-none border-assistant-border"
                                          } ${
                                            part.text.startsWith(
                                              "scheduled message"
                                            )
                                              ? "border-accent/50"
                                              : ""
                                          } relative`}
                                        >
                                          {part.text.startsWith(
                                            "scheduled message"
                                          ) && (
                                            <span className="absolute -top-3 -left-2 text-base">
                                              🕒
                                            </span>
                                          )}
                                          <span className="text-sm whitespace-pre-wrap">
                                            <ReactMarkdown
                                              components={{
                                                p: ({ children }) => (
                                                  <p>
                                                    <BacklinkRenderer
                                                      text={String(children)}
                                                      onNavigateToMemo={(
                                                        slug
                                                      ) => {
                                                        setActiveTab(
                                                          "fragments"
                                                        );
                                                        setViewingFragment(
                                                          slug
                                                        );
                                                      }}
                                                    />
                                                  </p>
                                                ),
                                              }}
                                            >
                                              {part.text.replace(
                                                /^scheduled message: /,
                                                ""
                                              )}
                                            </ReactMarkdown>
                                          </span>
                                        </Card>
                                        <p
                                          className={`text-xs text-muted-foreground mt-1 ${isUser ? "text-right" : "text-left"}`}
                                        >
                                          {formatTime(
                                            new Date(
                                              m.createdAt as unknown as string
                                            )
                                          )}
                                        </p>
                                      </div>
                                    );
                                  }

                                  if (part.type === "tool-invocation") {
                                    const toolInvocation = part.toolInvocation;
                                    const toolCallId =
                                      toolInvocation.toolCallId;

                                    if (
                                      toolsRequiringConfirmation.includes(
                                        toolInvocation.toolName as keyof typeof tools
                                      ) &&
                                      toolInvocation.state === "call"
                                    ) {
                                      return (
                                        <Card
                                          key={i}
                                          className="p-4 my-3 rounded-md bg-neutral-100 dark:bg-neutral-900"
                                        >
                                          <div className="flex items-center gap-2 mb-3">
                                            <div className="bg-[#F48120]/10 p-1.5 rounded-full">
                                              <Robot
                                                size={16}
                                                className="text-[#F48120]"
                                              />
                                            </div>
                                            <h4 className="font-medium">
                                              {toolInvocation.toolName}
                                            </h4>
                                          </div>

                                          <div className="mb-3">
                                            <h5 className="text-xs font-medium mb-1 text-muted-foreground">
                                              Arguments:
                                            </h5>
                                            <pre className="bg-background/80 p-2 rounded-md text-xs overflow-auto">
                                              {JSON.stringify(
                                                toolInvocation.args,
                                                null,
                                                2
                                              )}
                                            </pre>
                                          </div>

                                          <div className="flex gap-2 justify-end">
                                            <Button
                                              variant="primary"
                                              size="sm"
                                              onClick={() =>
                                                addToolResult({
                                                  toolCallId,
                                                  result: APPROVAL.NO,
                                                })
                                              }
                                            >
                                              Reject
                                            </Button>
                                            <Tooltip content={"Accept action"}>
                                              <Button
                                                variant="primary"
                                                size="sm"
                                                onClick={() =>
                                                  addToolResult({
                                                    toolCallId,
                                                    result: APPROVAL.YES,
                                                  })
                                                }
                                              >
                                                Approve
                                              </Button>
                                            </Tooltip>
                                          </div>
                                        </Card>
                                      );
                                    }
                                    return null;
                                  }
                                  return null;
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Chat Input Area */}
                <form
                  onSubmit={(e) =>
                    handleAgentSubmit(e, {
                      data: {
                        annotations: {
                          hello: "world",
                        },
                      },
                    })
                  }
                  className="p-3 bg-input-background absolute bottom-0 left-0 right-0 z-10 border-t border-neutral-300 dark:border-neutral-800"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                      <TextArea
                        disabled={pendingToolCallConfirmation}
                        placeholder={
                          pendingToolCallConfirmation
                            ? "Please respond to the tool confirmation above..."
                            : "Type your message..."
                        }
                        className="pl-4 pr-10 py-2 w-full rounded-md"
                        value={agentInput}
                        onChange={handleAgentInputChange}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleAgentSubmit(e as unknown as React.FormEvent);
                          }
                        }}
                        rows={2}
                        onValueChange={undefined}
                      />
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="md"
                      shape="square"
                      className="rounded-full h-10 w-10 flex-shrink-0"
                      onClick={isSessionActive ? stopSession : startSession}
                      aria-label={
                        isSessionActive
                          ? "Stop voice session"
                          : "Start voice session"
                      }
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-5 w-5"
                      >
                        {isSessionActive ? (
                          <circle cx="12" cy="12" r="10" fill="currentColor" />
                        ) : (
                          <>
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                          </>
                        )}
                      </svg>
                    </Button>

                    <Button
                      type="submit"
                      shape="square"
                      className="rounded-full h-10 w-10 flex-shrink-0"
                      disabled={
                        pendingToolCallConfirmation || !agentInput.trim()
                      }
                    >
                      <PaperPlaneRight size={16} />
                    </Button>
                  </div>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const hasOpenAiKeyPromise = fetch("/check-open-ai-key").then((res) =>
  res.json<{ success: boolean }>()
);

function HasOpenAIKey() {
  const hasOpenAiKey = use(hasOpenAiKeyPromise);

  if (!hasOpenAiKey.success) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-red-500/10 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-red-200 dark:border-red-900 p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                <svg
                  className="w-6 h-6 text-red-600 dark:text-red-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
                  OpenAI API Key Not Configured
                </h3>
                <p className="text-neutral-600 dark:text-neutral-300 mb-1">
                  Requests to the API, including from the frontend UI, will not
                  work until an OpenAI API key is configured.
                </p>
                <p className="text-neutral-600 dark:text-neutral-300">
                  Please configure an OpenAI API key by setting a{" "}
                  <a
                    href="https://developers.cloudflare.com/workers/configuration/secrets/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    secret
                  </a>{" "}
                  named{" "}
                  <code className="bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 font-mono text-sm">
                    OPENAI_API_KEY
                  </code>
                  . <br />
                  To use Anthropic models, also configure an{" "}
                  <code className="bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 font-mono text-sm">
                    ANTHROPIC_API_KEY
                  </code>
                  . <br />
                  You can also use a different model provider by following these{" "}
                  <a
                    href="https://github.com/cloudflare/agents-starter?tab=readme-ov-file#use-a-different-ai-model-provider"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    instructions
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
