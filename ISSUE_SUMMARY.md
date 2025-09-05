# Issue #7498: AI_InvalidDataContentError when using image message (Gemini provider)

## Problem Summary

When passing an image message to `chatAgent.streamVNext` with `format: 'aisdk'` and a remote URL as the data field, Mastra throws an `AI_InvalidDataContentError`. The framework attempts to parse the URL as a base64 string instead of handling it as a remote URL.

## Key Information

### Failing Case

```ts
const modelMessages = [
  {
    role: 'user',
    content: [
      {
        type: 'file',
        mediaType: 'image/png',
        data: 'https://storage.easyquiz.cc/ai-chat/20250905cdacd4dff092.png', // remote URL
      },
      { type: 'text', text: 'Describe it' },
    ],
  },
];

const res = await chatAgent.streamVNext(modelMessages, {
  format: 'aisdk',
  stopWhen: stepCountIs(15),
  runtimeContext,
});
```

### Working Case

```ts
// Works with base64 string (no data URL prefix)
{
  type: "file",
  mediaType: "image/png",
  data: "<BASE64_STRING>"
}
```

### Error Stack

```
AI_InvalidDataContentError: Invalid data content. Content string is not a base64-encoded media.
    at convertDataContentToUint8Array (ai/dist/index.mjs:1243:17)
    at attachmentsToParts (ai/dist/index.mjs:1680:20)
    at convertToCoreMessages (ai/dist/index.mjs:1765:67)
```

## Related Context

This issue appeared after fixing issue #7362 in Mastra v0.16.0. The fix for #7362 addressed:

- Google Gemini API expecting base64 encoded images
- Images being sent as raw bytes instead of properly encoded

However, the fix introduced a new problem where:

1. URLs are being incorrectly transformed into invalid data URLs like `data:image/png;base64,https://...`
2. The `InputProcessor` receives malformed parts with URLs prefixed as if they were base64 data
3. The AI SDK then tries to decode this malformed string as base64 and fails

## Environment

- Mastra: `@mastra/core@^0.16.0`
- AI SDK: `ai@^5.0.32`
- Provider: `@ai-sdk/google@^2.0.12`
- Model: Gemini

## Root Cause Analysis

The issue is in `packages/core/src/agent/message-list/index.ts` in the `mastraMessageV2ToMastraMessageV3` method:

1. When a V2 message has a file part with `data: "https://..."` URL
2. The code checks if it starts with `http://` or `https://` at line 2153
3. If it does, it correctly creates a file part with `url` field
4. **BUG**: If the URL doesn't start with those prefixes (shouldn't happen but code allows it), it falls into the else branch at line 2161
5. At line 2169, `parseDataUri` is called on the URL, which returns `{ isDataUri: false, base64Content: <URL> }`
6. At line 2182, `createDataUri` is called with the URL as if it were base64 content
7. This creates an invalid data URI: `data:image/png;base64,https://...`
8. When converted back to V2 for InputProcessors (line 1985), this malformed data URI is set as the `data` field
9. The AI SDK then tries to decode this as base64 and fails

## Issue Location

**File**: `packages/core/src/agent/message-list/index.ts`
**Method**: `mastraMessageV2ToMastraMessageV3`
**Lines**: 2151-2193 (specifically the bug is around line 2182)

The fix for #7362 introduced this regression by incorrectly handling URLs that get passed through the non-HTTP branch of the file part processing.
