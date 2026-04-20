export interface TranscriptTextEntry {
  role: string
  text: string
}

function normalizeTranscriptText(text: string): string {
  return text.trim()
}

function mergeAssistantTextSegments(segments: string[]): string {
  const mergedSegments: string[] = []

  for (const segment of segments.map(normalizeTranscriptText).filter(Boolean)) {
    const previousSegment = mergedSegments.at(-1)

    if (!previousSegment) {
      mergedSegments.push(segment)
      continue
    }

    if (segment === previousSegment || segment.startsWith(previousSegment)) {
      mergedSegments[mergedSegments.length - 1] = segment
      continue
    }

    if (previousSegment.startsWith(segment)) {
      continue
    }

    mergedSegments.push(segment)
  }

  return mergedSegments.join('\n\n').trim()
}

export function getLastUserTranscriptIndex(transcript: TranscriptTextEntry[]): number | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === 'user' && normalizeTranscriptText(transcript[index].text)) {
      return index
    }
  }

  return null
}

export function getAssistantContentFromTranscriptEntries(transcript: TranscriptTextEntry[]): string {
  return mergeAssistantTextSegments(transcript.filter((entry) => entry.role === 'assistant').map((entry) => entry.text))
}

export function getAssistantContentAfterCursor(transcriptCursor: number, transcript: TranscriptTextEntry[]): string {
  const sliceStart = Math.min(transcript.length, Math.max(0, transcriptCursor + 1))
  return getAssistantContentFromTranscriptEntries(transcript.slice(sliceStart))
}

export function getAssistantContentAfterLastUser(transcript: TranscriptTextEntry[]): string {
  const lastUserEntryIndex = getLastUserTranscriptIndex(transcript)

  return getAssistantContentFromTranscriptEntries(
    typeof lastUserEntryIndex === 'number' ? transcript.slice(lastUserEntryIndex + 1) : transcript.slice(),
  )
}
