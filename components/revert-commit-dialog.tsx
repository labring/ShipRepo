'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface Commit {
  sha: string
  commit: {
    author: {
      name: string
      email: string
      date: string
    }
    message: string
  }
  author: {
    login: string
    avatar_url: string
  } | null
  html_url: string
}

interface RevertCommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commit: Commit | null
  owner: string
  repo: string
  onRevert: (config: {
    commit: Commit
    selectedAgent: string
    selectedModel: string
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
  }) => void
  maxSandboxDuration?: number
}

const FIXED_TASK_AGENT = 'codex'
const FIXED_TASK_MODEL = 'gpt-5.4'

export function RevertCommitDialog({
  open,
  onOpenChange,
  commit,
  owner,
  repo,
  onRevert,
  maxSandboxDuration = 300,
}: RevertCommitDialogProps) {
  const [installDependencies, setInstallDependencies] = useState(false)
  const [maxDuration, setMaxDuration] = useState(300)
  const [keepAlive, setKeepAlive] = useState(false)
  const [isReverting, setIsReverting] = useState(false)

  const handleRevert = () => {
    if (!commit) return

    setIsReverting(true)
    onRevert({
      commit,
      selectedAgent: FIXED_TASK_AGENT,
      selectedModel: FIXED_TASK_MODEL,
      installDependencies,
      maxDuration,
      keepAlive,
    })
    setIsReverting(false)
    onOpenChange(false)
  }

  if (!commit) return null

  const commitShortSha = commit.sha.substring(0, 7)
  const commitMessage = commit.commit.message.split('\n')[0]

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Revert Commit</AlertDialogTitle>
          <AlertDialogDescription>
            Create a new task to revert commit <code className="bg-muted px-1 py-0.5 rounded">{commitShortSha}</code>:{' '}
            {commitMessage}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="py-4 space-y-4">
          <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
            This task will run with <span className="font-medium text-foreground">Codex</span> on{' '}
            <span className="font-medium text-foreground">GPT-5.4</span>.
          </div>

          {/* Task Options */}
          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-3">Task Options</h3>
            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="revert-install-deps"
                  checked={installDependencies}
                  onCheckedChange={(checked) => setInstallDependencies(!!checked)}
                />
                <Label
                  htmlFor="revert-install-deps"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Install Dependencies?
                </Label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="revert-max-duration" className="text-sm font-medium">
                  Maximum Duration
                </Label>
                <Select value={maxDuration.toString()} onValueChange={(value) => setMaxDuration(parseInt(value))}>
                  <SelectTrigger id="revert-max-duration" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 minutes</SelectItem>
                    <SelectItem value="10">10 minutes</SelectItem>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                    <SelectItem value="45">45 minutes</SelectItem>
                    <SelectItem value="60">1 hour</SelectItem>
                    <SelectItem value="120">2 hours</SelectItem>
                    <SelectItem value="180">3 hours</SelectItem>
                    <SelectItem value="240">4 hours</SelectItem>
                    <SelectItem value="300">5 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="revert-keep-alive"
                  checked={keepAlive}
                  onCheckedChange={(checked) => setKeepAlive(!!checked)}
                />
                <Label
                  htmlFor="revert-keep-alive"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Keep Alive ({maxSandboxDuration} minutes max)
                </Label>
              </div>
            </div>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRevert} disabled={isReverting}>
            {isReverting ? 'Creating...' : 'Create Task'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
