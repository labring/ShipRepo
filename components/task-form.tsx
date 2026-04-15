'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ArrowUp } from 'lucide-react'
import { useAtom } from 'jotai'
import { taskPromptAtom } from '@/lib/atoms/task'
import { githubReposAtomFamily } from '@/lib/atoms/github-cache'

interface GitHubRepo {
  name: string
  full_name: string
  description: string
  private: boolean
  clone_url: string
  language: string
}

interface TaskFormProps {
  onSubmit: (data: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    selectedModels?: string[]
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
  }) => void
  isSubmitting: boolean
  selectedOwner: string
  selectedRepo: string
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
}

const FIXED_TASK_AGENT = 'codex'
const FIXED_TASK_MODEL = 'gpt-5.3-codex'

export function TaskForm({
  onSubmit,
  isSubmitting,
  selectedOwner,
  selectedRepo,
  initialMaxDuration = 300,
}: TaskFormProps) {
  const [prompt, setPrompt] = useAtom(taskPromptAtom)
  const [repos, setRepos] = useAtom(githubReposAtomFamily(selectedOwner))
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') {
      return
    }

    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

    if (!isMobile && !event.shiftKey) {
      event.preventDefault()
      if (prompt.trim()) {
        event.currentTarget.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
    }
  }

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!selectedOwner) {
      setRepos(null)
      return
    }

    const fetchRepos = async () => {
      if (repos && repos.length > 0) {
        return
      }

      try {
        const response = await fetch(`/api/github/repos?owner=${selectedOwner}`)
        if (response.ok) {
          const reposList = (await response.json()) as GitHubRepo[]
          setRepos(reposList)
        }
      } catch (error) {
        console.error('Error fetching repositories:', error)
      }
    }

    void fetchRepos()
  }, [repos, selectedOwner, setRepos])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()

    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      return
    }

    const selectedRepoData = repos?.find((repo) => repo.name === selectedRepo)

    onSubmit({
      prompt: trimmedPrompt,
      repoUrl: selectedRepoData?.clone_url || '',
      selectedAgent: FIXED_TASK_AGENT,
      selectedModel: FIXED_TASK_MODEL,
      installDependencies: false,
      maxDuration: initialMaxDuration,
      keepAlive: false,
      enableBrowser: false,
    })
  }

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Deploy on Sealos</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          当前阶段先打通本地 Codex Gateway，对话链路稳定后再切换到 Devbox 内 gateway。
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="overflow-hidden rounded-3xl border bg-background shadow-sm">
          <div className="border-b bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
            {selectedOwner && selectedRepo
              ? `${selectedOwner}/${selectedRepo}`
              : '先在顶部选择一个 GitHub 仓库，然后输入 deploy on sealos。'}
          </div>

          <div className="bg-transparent">
            <Textarea
              ref={textareaRef}
              id="prompt"
              placeholder="输入 deploy on sealos，或者描述你希望系统如何分析并部署这个仓库。"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSubmitting}
              required
              rows={6}
              className="min-h-[220px] w-full resize-none border-0 bg-transparent px-5 py-5 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>

          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="text-xs text-muted-foreground">固定运行时: Codex Gateway · gpt-5.3-codex</div>

            <Button type="submit" disabled={isSubmitting || !prompt.trim()} className="h-10 rounded-full px-4">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
