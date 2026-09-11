export type ConversationAttachment = Readonly<{
  id: string;
  sessionId: string;
  provider: string;
  conversationId: string;
  retention: "summary";
  attachedAt: string;
}>;

export type AttachConversationResult = Readonly<{
  operationId: string;
  attached: true;
}>;
