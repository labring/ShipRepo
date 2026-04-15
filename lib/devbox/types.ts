export interface DevboxEnvelope<T> {
  code: number
  message: string
  data: T
}

export interface DevboxHealthData {
  status: string
}

export interface DevboxState {
  spec: string
  status: string
  phase: string
}

export interface DevboxListItem {
  name: string
  creationTimestamp: string | null
  deletionTimestamp: string | null
  state: DevboxState
}

export interface DevboxSshInfo {
  user: string
  host: string
  port: number
  target: string
  link: string
  command: string
  privateKeyEncoding?: string
  privateKeyBase64?: string
}

export interface DevboxGatewayInfo {
  url?: string
  route?: string
  externalURL?: string
  appURL?: string
  accessURL?: string
  token?: string
  jwt?: string
  authToken?: string
  bearerToken?: string
  accessToken?: string
}

export interface DevboxInfo {
  name: string
  creationTimestamp: string | null
  deletionTimestamp: string | null
  state: DevboxState
  ssh?: DevboxSshInfo
  gateway?: DevboxGatewayInfo
}

export interface CreateDevboxLabel {
  key: string
  value: string
}

export interface CreateDevboxInput {
  name: string
  image?: string
  upstreamID?: string
  env?: Record<string, string>
  pauseAt?: string
  archiveAfterPauseTime?: string
  labels?: CreateDevboxLabel[]
}

export interface CreateDevboxResult {
  name: string
  namespace: string
  state: string
}

export interface PauseDevboxResult {
  name: string
  namespace: string
  state: string
}

export interface RefreshPauseInput {
  pauseAt: string
}

export interface RefreshPauseResult {
  name: string
  namespace: string
  pauseAt: string
  refreshedAt: string
}

export interface DeleteDevboxResult {
  name: string
  namespace: string
  status: string
}

export interface DevboxExecInput {
  command: string[]
  stdin?: string
  timeoutSeconds?: number
  container?: string
}

export interface DevboxExecResult {
  podName: string
  namespace: string
  container: string
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  executedAt: string
}
