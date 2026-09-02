sed -i '' -e '/const BUST_HOLD_MODAL_MS = 120_000;/a\
  const rebuyPromptDeadlineRef = useRef<number | null>(null);\
  const rebuyPromptTokenRef = useRef<string | null>(null);\
  const beginRebuyPrompt = useCallback((): string => {\
    const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `rebuy-${Date.now()}-${Math.random().toString(36).slice(2)}`;\
    rebuyPromptTokenRef.current = token;\
    return token;\
  }, []);\
  const endRebuyPrompt = useCallback(() => {\
    rebuyPromptTokenRef.current = null;\
    rebuyPromptDeadlineRef.current = null;\
  }, []);\
' src/pages/TablePage.tsx
