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
export type Group = { n: number; title: string; tools: string[]; step?: { n: number; m: number } }

export type EvidenceKind = 'commit' | 'external' | 'guide' | 'skill'
export type Evidence = { kind: EvidenceKind; text: string; group: number; count: number }

export type TurnStatus = 'idle' | 'running' | 'answer' | 'aborted' | 'refusal' | 'error'
export type Turn = { text: string; status: TurnStatus; startedAt: number; ms?: number }

export type Sub = {
  key: string
  id?: string
  type: string
  description: string
  status: 'running' | 'done' | 'denied'
  startedAt: number
  ms?: number
}

/** 백그라운드 셸 · 감시 · 예약 */
export type Bg = { id: string; label: string }

/** 끝난 작업 하나의 설명: 상황 → 스킬 → 지침 → 근거 → 한 일 → 검증 */
export type Story = {
  at: number
  request: string
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
      turn: Shaped<Turn>
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
