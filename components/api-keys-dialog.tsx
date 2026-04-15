'use client'

import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ApiKeysDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ApiKeyRecord {
  baseUrl?: string | null
  provider: 'aiproxy'
}

export function ApiKeysDialog({ open, onOpenChange }: ApiKeysDialogProps) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (open) {
      void fetchApiKeys()
    }
  }, [open])

  const fetchApiKeys = async () => {
    try {
      const response = await fetch('/api/api-keys')
      const data = await response.json()

      if (!data.success) {
        return
      }

      const aiProxyRecord = (data.apiKeys as ApiKeyRecord[]).find((record) => record.provider === 'aiproxy')

      setSaved(Boolean(aiProxyRecord))
      setApiKey('')
      setBaseUrl(aiProxyRecord?.baseUrl || '')
    } catch (error) {
      console.error('Error fetching API keys:', error)
    }
  }

  const handleSave = async () => {
    if (!apiKey.trim() || !baseUrl.trim()) {
      toast.error('Please enter a base URL and API key')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey,
          baseUrl,
          provider: 'aiproxy',
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        toast.error(error.error || 'Failed to save API key')
        return
      }

      toast.success('AIProxy configuration saved')
      setSaved(true)
      setApiKey('')
    } catch (error) {
      console.error('Error saving API key:', error)
      toast.error('Failed to save API key')
    } finally {
      setLoading(false)
    }
  }

  const handleClear = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/api-keys?provider=aiproxy', {
        method: 'DELETE',
      })

      if (!response.ok) {
        const error = await response.json()
        toast.error(error.error || 'Failed to clear API key')
        return
      }

      toast.success('AIProxy configuration cleared')
      setApiKey('')
      setBaseUrl('')
      setSaved(false)
    } catch (error) {
      console.error('Error clearing API key:', error)
      toast.error('Failed to clear API key')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>API Keys</DialogTitle>
          <DialogDescription>Configure the AIProxy base URL and API key used by Codex tasks.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aiproxy-base-url">AIProxy Base URL</Label>
            <Input
              id="aiproxy-base-url"
              placeholder="https://aiproxy.usw-1.sealos.io/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="aiproxy-api-key">AIProxy API Key</Label>
            <div className="relative">
              <Input
                id="aiproxy-api-key"
                type={showApiKey ? 'text' : 'password'}
                placeholder={saved ? '••••••••••••••••' : 'sk-...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={loading}
                className="pr-9"
              />
              <button
                onClick={() => setShowApiKey((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                type="button"
                disabled={loading}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            {saved ? (
              <Button variant="ghost" onClick={handleClear} disabled={loading}>
                Clear
              </Button>
            ) : null}
            <Button onClick={handleSave} disabled={loading || !apiKey.trim() || !baseUrl.trim()}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
