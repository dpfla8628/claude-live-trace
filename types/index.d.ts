export type Phase = 'explore' | 'guide' | 'change' | 'verify'
export type CallStatus = 'running' | 'ok' | 'error' | 'denied'
export type Call = {
  id: string
  tool: string
  /** 한국어 동작 이름 */
  label: string
  /** 개수 셀 종류(소스 · 지침 메모 · 위키 · 검색 …), '' = 안 셈 */
  src: string
  /** 펼친 화면에만 흐리게 붙는 대상(파일 이름) */
  target?: string
  phase: Phase
  /** 이 동작이 속한 작업 번호 */
  task: number
  /** 묶음 번호, 0 = 설명 없이 시작 */
  group: number
  agent?: string
  /** 문서 파일(.md · .txt) 수정 */
  isDoc?: boolean
  status: CallStatus
  startedAt: number
  ms?: number
}

/** Claude 가 도구 전에 쓴 문장 하나 = 묶음 하나 */
export type Group = { n: number; task: number; title: string; tools: string[]; step?: { n: number; m: number } }

export type EvidenceKind = 'commit' | 'external' | 'guide' | 'skill'
export type Evidence = { kind: EvidenceKind; text: string; task: number; group: number; count: number }

export type TurnStatus = 'idle' | 'running' | 'answer' | 'aborted' | 'refusal' | 'error'

/** 사용자 요청 하나 = 작업 하나. 이어서 하는 턴(백그라운드 알림 · 반복 예약)은 같은 작업에 붙는다 */
export type Task = {
  /** 세션 안에서 1부터 */
  id: number
  request: string
  status: TurnStatus
  startedAt: number
  /** 지금(또는 마지막) 턴이 시작한 때 */
  turnAt: number
  /** 턴들의 걸린 시간 합 */
  ms?: number
  /** 작업 중에 사용자가 더 보낸 요청(엔진이 지금 턴에 넣어 준 것) */
  asks?: string[]
}

export type Sub = {
  key: string
  id?: string
  task: number
  type: string
  description: string
  status: 'running' | 'done' | 'denied'
  startedAt: number
  ms?: number
}

/** 백그라운드 셸 · 감시 · 예약 */
export type Bg = { id: string; label: string; task: number }

/** 끝난 작업 하나의 설명: 상황 → 스킬 → 지침 → 근거 → 한 일 → 검증 */
export type Story = {
  task: number
  at: number
  /** 작업 폴더 이름 */
  where?: string
  request: string
  /** 작업 중에 더 받은 요청 */
  asks?: string[]
  status: TurnStatus
  skills: string[]
  guides: string[]
  basis: string[]
  steps: string[]
  checks: string[]
  unverified: boolean
  /** 확인한 것을 종류별 개수로(파일 이름은 나열하지 않음): 「소스 5개」 하나씩 */
  sources: string[]
  /** sources 를 쉼표로 이은 글(기록 파일용) */
  explored: string
  ms?: number
}

declare module 'claude-code' {
  interface PluginState {
    'live-trace': {
      calls: Shaped<Call[]>
      tasks: Shaped<Task[]>
      /** 사람이 고른 작업 번호, 0 = 가장 최근 작업을 따라감 */
      focus: Shaped<number>
      subs: Shaped<Sub[]>
      groups: Shaped<Group[]>
      evidence: Shaped<Evidence[]>
      bg: Shaped<Bg[]>
      stories: Shaped<Story[]>
      /** 사람이 펼친 단계 번호 */
      opened: Shaped<number[]>
    }
  }
}
