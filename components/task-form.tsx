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
  isAuthenticated: boolean
  selectedOwner: string
  selectedRepo: string
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
}

const FIXED_TASK_AGENT = 'codex'
const FIXED_TASK_MODEL = 'gpt-5.4'

export function TaskForm({
  onSubmit,
  isSubmitting,
  isAuthenticated,
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

  const hasSelectedRepo = Boolean(selectedOwner && selectedRepo)

  const title = !isAuthenticated
    ? 'Sign In to Deploy on Sealos'
    : hasSelectedRepo
      ? 'Deploy Your Project to Sealos'
      : 'Choose a Repository to Deploy'

  const description = !isAuthenticated
    ? 'Sign in first, then choose a GitHub repository and tell Sealos how it should be analyzed, built, and deployed.'
    : hasSelectedRepo
      ? 'Tell Sealos what you want to do with this repository. A simple deployment request is enough.'
      : 'Connect GitHub if needed, choose a repository, then describe how Sealos should analyze, build, and deploy it.'

  const repoBannerText = hasSelectedRepo
    ? `${selectedOwner}/${selectedRepo}`
    : !isAuthenticated
      ? 'Sign in to choose a GitHub repository.'
      : 'Choose a GitHub repository from the header to begin.'

  const placeholder = !isAuthenticated
    ? 'Sign in first. After that, choose a repository and describe the deployment task here.'
    : hasSelectedRepo
      ? 'For example: deploy this repository to Sealos.'
      : 'Choose a repository first. Then describe how Sealos should build and deploy it.'

  const helperText = !isAuthenticated
    ? 'Start by signing in. After you pick a repository, you can describe the deployment task here.'
    : hasSelectedRepo
      ? ''
      : 'After you pick a repository, describe what Sealos should build and deploy.'

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="overflow-hidden rounded-2xl border bg-background shadow-sm">
          <div className="border-b bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">{repoBannerText}</div>

          <div className="bg-transparent">
            <Textarea
              ref={textareaRef}
              id="prompt"
              placeholder={placeholder}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSubmitting}
              required
              rows={4}
              className="min-h-[140px] w-full resize-none border-0 bg-transparent px-4 py-4 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-base"
            />
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="text-xs text-muted-foreground">{helperText}</div>

            <Button type="submit" disabled={isSubmitting || !prompt.trim()} className="h-9 rounded-full px-3">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
