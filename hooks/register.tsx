import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Bg, Call, CallStatus, Evidence, Group, Phase, Story, Sub, Turn, TurnStatus } from '../types'
import {
  agentName,
  citedCommits,
  clip,
  countActions,
  duration,
  evidenceOf,
  firstSentence,
  groupLabel,
  labelOf,
  linesOf,
  mergeEvidence,
  parseNarration,
  phaseOf,
  sourceOf,
  storyText,
  targetOf,
  ymd,
} from './describe'

const PANE = 'live-trace'
const TITLE = '작업 과정'
// shape 태그: 필드가 바뀌면 올린다(리로드 뒤 남은 예전 값을 버리게)
const calls = atom({ plugin: 'live-trace', key: 'calls' } as const, [], { shape: 'calls-3' })
const subs = atom({ plugin: 'live-trace', key: 'subs' } as const, [], { shape: 'subs-1' })
const turn = atom(
  { plugin: 'live-trace', key: 'turn' } as const,
  { text: '', status: 'idle', startedAt: 0 },
  { shape: 'turn-1' },
)
const groups = atom({ plugin: 'live-trace', key: 'groups' } as const, [], { shape: 'groups-1' })
const evidence = atom({ plugin: 'live-trace', key: 'evidence' } as const, [], { shape: 'evidence-2' })
const bg = atom({ plugin: 'live-trace', key: 'bg' } as const, [], { shape: 'bg-1' })
const stories = atom({ plugin: 'live-trace', key: 'stories' } as const, [], { shape: 'stories-3' })
const opened = atom({ plugin: 'live-trace', key: 'opened' } as const, [], { shape: 'opened-1' })

const RULE = `[live-trace] 옆 패널이 사용자에게 작업 과정을 보여 준다. 패널은 네가 화면에 쓰는 문장을 그대로 읽는다.
- 도구를 부르기 전 문장은 「무엇을 · 왜」 한 줄 한국어로 쓴다. 예: 네모가 된 이유부터 찾으려고 버튼 변경 이력을 봅니다
- 여러 단계 작업이면 각 단계를 시작하는 문장 앞에 [지금 단계/전체 단계] 를 붙인다. 예: [2/4] 피그마 원본과 비교합니다
- 규칙 · 메모리 · 스킬의 지침을 따라 정할 때는 그 문장 끝에 (지침: 이름) 을 붙인다. 예: (지침: 디자인 우선순위)
- Bash · PowerShell 의 description 은 한국어로 쓴다.
- 사용자가 지난 작업을 「어떻게 했어?」 「무슨 근거로 했어?」 물으면 ~/.claude/live-trace/ 의 날짜별 기록(YYYY-MM-DD.md)을 읽고, 상황 → 쓴 스킬 → 따른 지침 → 근거 → 한 일 → 검증 순서로 답한다.`

const PHASES: readonly [Phase, string][] = [
  ['explore', '조사'],
  ['guide', '근거'],
  ['change', '변경'],
  ['verify', '검증'],
]
const PHASE_PCT: Record<Phase, number> = { explore: 15, guide: 35, change: 60, verify: 85 }
const ICON: Record<CallStatus, string> = { running: '⊷', ok: '✓', error: '✗', denied: '⊘' }
const COLOR = { running: 'warning', ok: 'success', error: 'error', denied: 'error' } as const
const TAG: Record<Evidence['kind'], string> = {
  commit: '커밋',
  external: '외부',
  guide: '지침',
  skill: '스킬',
}
const ORDER: readonly Evidence['kind'][] = ['commit', 'external', 'guide', 'skill']
const DONE_LABEL: Record<TurnStatus, string> = {
  idle: '대기',
  running: '작업 중',
  answer: '끝남',
  aborted: '중단됨',
  refusal: '거절됨',
  error: '오류로 멈춤',
}

const isContinuation = (text: string) => text.trim() === '' || text.trimStart().startsWith('<')

const prettyModel = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${(m[1] ?? '').replace(/^./, c => c.toUpperCase())} ${m[2]}.${m[3]}` : id
}

/** 끝난 턴 → 작업 설명 */
const buildStory = (
  t: Turn,
  mine: readonly Call[],
  gs: readonly Group[],
  ev: readonly Evidence[],
  at: number,
  answer: string,
): Story => {
  const of = (k: Evidence['kind']) => ev.filter(x => x.kind === k).map(x => x.text)
  // 문서(.md 등) 수정은 검증할 대상이 아니므로 「바꾼 뒤 검증 안 함」에서 뺀다
  const kinds = mine.map(c => (c.phase === 'change' && c.isDoc === true ? 'doc' : c.phase))
  const lastChange = kinds.lastIndexOf('change')
  const lastVerify = kinds.lastIndexOf('verify')
  const checks = [
    ...new Set(
      mine.filter(c => c.phase === 'verify').map(c => `${c.label} ${c.status === 'ok' ? '통과' : '실패'}`),
    ),
  ].slice(-5)
  const sources = countActions(mine.map(c => c.src))
  return {
    at,
    request: t.text,
    status: t.status,
    skills: of('skill'),
    guides: of('guide'),
    // 파일 이름은 나열하지 않는다(많으면 길어짐) — 종류별 개수만
    // 커밋은 최종 답이 든 것(없으면 마지막에 찾은 3개), 외부 근거는 3개까지
    basis: [...citedCommits(of('commit'), answer), ...of('external').slice(0, 3)],
    sources,
    explored: sources.join(', '),
    ...(t.ms !== undefined ? { ms: t.ms } : {}),
    steps: gs.map(g => `${g.step ? `${groupLabel(g)} ` : ''}${g.title}`),
    checks,
    unverified: lastChange >= 0 && lastVerify < lastChange,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'trace', description: '작업 과정 패널 열기 · /trace 설명 = 마지막 작업 설명' })
    // 오른쪽 자리(전체 화면 모드)는 52칸, 입력창 위 자리는 14줄로 시작. 사람이 끌거나 키로 바꾼 크기가 우선.
    void $.ui.open({ id: PANE, title: TITLE, columns: 52, rows: 14 })
    // 작업 중엔 1초마다 다시 그려 경과 시간이 흐르게(쉬는 동안은 그리지 않음)
    $.clock.every(1000, () => {
      void read($, turn).then(t => {
        if (t.status === 'running') $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  on('command.run', { command: 'trace' }, async ($, e) => {
    if (e.args.trim() === '설명') {
      const last = (await read($, stories)).at(-1)

      return { text: last ? storyText(last) : '아직 끝난 작업이 없습니다.' }
    }
    await $.ui.open({ id: PANE, title: TITLE, columns: 52, rows: 14 })

    return { text: '작업 과정 패널을 열었습니다. 끝난 작업 설명은 /trace 설명' }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)

    return { sections: [...r.sections, { id: 'live-trace:narrate', text: RULE, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, turn, (t): Turn => ({
        text: isContinuation(e.text) ? t.text : clip(e.text, 200),
        status: 'running',
        startedAt: now,
      }))
      await update($, groups, () => [])
      await update($, evidence, () => [])
      await update($, opened, () => [])
    } else {
      await update($, subs, list => list.map(s => (s.id === e.agentId ? { ...s, status: 'running', ms: undefined } : s)))
    }

    return next(e)
  })

  // 화면에 쓰는 문장 → 그 뒤 도구들의 묶음 제목. 생각 조각은 읽지 않는다. 조각은 손대지 않고 넘긴다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      yield* next(e)
      return
    }
    let text = ''
    for await (const c of next(e)) {
      yield c
      if (c.kind === 'text') text += c.text
      if (c.kind !== 'tool') continue
      const said = parseNarration(text)
      text = ''
      try {
        let made: Group | undefined
        await update($, groups, list => {
          const last = list.at(-1)
          if (said.title === '' && last !== undefined) {
            return [...list.slice(0, -1), { ...last, tools: [...last.tools, c.id] }]
          }
          made = {
            n: list.length + 1,
            title: said.title || '(설명 없이 시작)',
            tools: [c.id],
            ...(said.step ? { step: said.step } : {}),
          }
          return [...list, made].slice(-40)
        })
        const g = made
        if (g !== undefined && said.guides.length > 0) {
          await update($, evidence, list =>
            mergeEvidence(
              list,
              said.guides.map(t => ({ kind: 'guide', text: t, group: g.n, count: 1 })),
            ),
          )
        }
      } catch {
        // 관찰 전용: 기록이 실패해도 응답은 그대로
      }
    }
  })

  on('skill.prompt', async ($, e, next) => {
    const g = (await read($, groups)).at(-1)?.n ?? 0
    await update($, evidence, list => mergeEvidence(list, [{ kind: 'skill', text: e.skill, group: g, count: 1 }]))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      await update($, subs, list =>
        list.map(s => (s.id === e.agentId ? { ...s, status: 'done', ms: now - s.startedAt } : s)),
      )

      return next(e)
    }
    await update($, turn, t => ({ ...t, status: e.reason, ms: e.durationMs }))
    const t = await read($, turn)
    const mine = (await read($, calls)).filter(c => c.startedAt >= t.startedAt && c.agent === undefined)
    if (mine.length > 0) {
      const story = buildStory(t, mine, await read($, groups), await read($, evidence), now, e.answer)
      await update($, stories, list => [...list, story].slice(-10))
      try {
        const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
        if (home !== undefined) {
          const path = `${home.replace(/\\/g, '/')}/.claude/live-trace/${ymd(now)}.md`
          let old = ''
          try {
            old = String(await $.fs.read(path))
          } catch {
            old = `# 작업 기록 ${ymd(now)}\n`
          }
          await $.fs.write(path, `${old.trimEnd()}\n\n${storyText(story)}\n`)
        }
      } catch {
        // 기록 파일을 못 써도 패널은 그대로
      }
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const key = `${e.tool_use_id}:${startedAt}`
    const sub: Sub = { key, type: e.subagentType, description: e.description, status: 'running', startedAt }
    await update($, subs, list => [...list, sub].slice(-30))
    const spawned = await next(e)
    await update($, subs, list =>
      list.map(s =>
        s.key !== key ? s : spawned.deny !== undefined ? { ...s, status: 'denied' } : { ...s, id: spawned.agentId },
      ),
    )

    return spawned
  }).catch(($, e, next) => next(e)) // 관찰 전용

  // 턴이 멈출 때마다 엔진이 아는 백그라운드 목록으로 맞춘다
  on('classic.Stop', async ($, e, next) => {
    const tasks = (e.background_tasks ?? []).filter(x => x.type !== 'subagent')
    const crons = e.session_crons ?? []
    await update($, bg, () => [
      ...tasks.map(x => ({
        id: x.id,
        label: x.type === 'shell' ? labelOf('Bash', { command: x.command ?? '', description: x.description }) : clip(x.description || x.type),
      })),
      ...crons.map(c => ({ id: c.id, label: c.recurring ? '정기 작업 예약됨' : '다시 진행 예약됨' })),
    ])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const args = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const gs = await read($, groups)
    const group =
      e.agentId === undefined ? ((gs.find(g => g.tools.includes(e.tool_use_id)) ?? gs.at(-1))?.n ?? 0) : 0
    const call: Call = {
      id: e.tool_use_id,
      tool,
      label: labelOf(tool, args),
      src: sourceOf(tool, args),
      ...(targetOf(tool, args) !== undefined ? { target: targetOf(tool, args) } : {}),
      phase: phaseOf(tool, args),
      ...(/\.(md|txt)$/i.test(String(args.file_path ?? '')) ? { isDoc: true } : {}),
      group,
      status: 'running',
      startedAt,
      ...(e.agentId !== undefined ? { agent: e.agentId } : {}),
    }
    await update($, calls, list => [...list, call].slice(-300))
    const finish = async (status: CallStatus) => {
      const ms = (await $.clock.now()) - startedAt
      await update($, calls, list => list.map(c => (c.id === call.id ? { ...c, status, ms } : c)))
    }
    try {
      const ran = await next(e)
      await finish(ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok')
      if (e.agentId === undefined && ran.deny === undefined) {
        // 메모를 읽었으면 같은 폴더의 목차(MEMORY.md)에서 한글 제목을 찾는다
        let memoIndex = ''
        const path = String(args.file_path ?? '').replace(/\\/g, '/')
        if (tool === 'Read' && /\/memory\/[^/]+\.md$/.test(path)) {
          try {
            memoIndex = String(await $.fs.read(path.replace(/[^/]+$/, 'MEMORY.md')))
          } catch {
            // 목차가 없으면 지침 이름 없이 개수만
          }
        }
        const found = evidenceOf(tool, args, ran.text ?? '', group, memoIndex)
        if (found.length > 0) await update($, evidence, list => mergeEvidence(list, found))
        const isBg = args.run_in_background === true && (tool === 'Bash' || tool === 'PowerShell')
        if (isBg || tool === 'Monitor') {
          await update($, bg, list => [...list, { id: call.id, label: call.label }].slice(-10))
        }
        if (tool === 'ScheduleWakeup' && args.stop !== true) {
          await update($, bg, list => [...list.filter(b => b.id !== 'wake'), { id: 'wake', label: call.label }])
        }
        if (tool === 'ScheduleWakeup' && args.stop === true) {
          await update($, bg, list => list.filter(b => b.id !== 'wake'))
        }
      }

      return ran
    } catch (err) {
      await finish('error')
      throw err
    }
  }).catch(($, e, next) => next(e)) // 관찰 전용: 기록이 실패해도 도구 호출은 그대로


  // 화면: 위(지금 · 진행 · 단계 줄) → 흐름(큰 단계가 위에서 아래로, + 로 펼침) → 백그라운드 → 근거 → 사용량
  // 글은 자르지 않고 줄을 바꾼다. 색은 상태(초록 성공 · 노랑 진행 · 빨강 실패)에만.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress, Button } = $.ui.resolve(e)
    const t = await read($, turn)
    const all = await read($, calls)
    const gs = await read($, groups)
    const ev = await read($, evidence)
    const agents = await read($, subs)
    const bgs = await read($, bg)
    const done = await read($, stories)
    const open = await read($, opened)
    let now = t.startedAt
    try {
      now = await $.clock.now()
    } catch {
      // 시계를 못 읽으면 경과 시간만 멈춘다
    }
    const cols = Math.max(20, (e.props.bodyColumns ?? 40) - 1) // 넓은 글자가 밀리지 않게 한 칸 비움
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 20

    let hud = ''
    try {
      const usage = await $.session.usage()
      const model = prettyModel(await $.session.model())
      const limit = (kind: string, name: string) => {
        const r = usage.rateLimits.find(x => x.kind === kind)
        return r ? `${name} ${Math.round(r.percentUsed)}%` : ''
      }
      hud = [
        model,
        usage.context.percent !== undefined ? `대화 용량 ${usage.context.percent}%` : '',
        limit('five_hour', '5시간 한도'),
        limit('seven_day', '주간 한도'),
      ]
        .filter(Boolean)
        .join(' | ')
    } catch {
      // 사용량을 못 읽으면 그 줄만 뺀다
    }

    // 이름표는 흐리게, 내용은 줄바꿈. 들여쓴 줄은 Box 여백으로(넘어간 줄도 같은 자리에서 시작)
    const Row = (label: string, value: string, opts: { bold?: boolean; color?: 'success' | 'error' } = {}) => (
      <Text wrap="wrap">
        <Text dimColor>{label}</Text>{' '}
        <Text bold={opts.bold} color={opts.color}>
          {value}
        </Text>
      </Text>
    )
    const rowLines = (label: string, value: string) => linesOf(`${label} ${value}`, cols)
    const Section = (name: string) => <Text bold>{name}</Text>
    const Indent = (pad: number, child: JSX.Element) => <Box paddingLeft={pad}>{child}</Box>

    const mine = all.filter(c => c.startedAt >= t.startedAt && c.agent === undefined)
    const isRunning = t.status === 'running'
    const story = !isRunning ? done.at(-1) : undefined
    const seen = new Set(mine.map(c => c.phase))
    const current = mine.at(-1)?.phase
    const runningCall = [...mine].reverse().find(c => c.status === 'running')
    const step = [...gs].reverse().find(g => g.step)?.step
    const furthest = PHASES.map(([p]) => p).filter(p => seen.has(p)).at(-1)
    // 단계 표시가 있으면 지금 단계의 가운데로 잡는다(첫 단계에서 0% 로 멈춰 보이지 않게)
    const pct = !isRunning
      ? 100
      : step
        ? Math.round(((step.n - 0.5) / Math.max(1, step.m)) * 100)
        : furthest
          ? PHASE_PCT[furthest]
          : 5
    const pctText = !isRunning ? '100%' : step ? `${step.n}/${step.m}단계 ${pct}%` : `약 ${pct}%`
    const lastTouch = Math.max(t.startedAt, ...mine.map(c => c.startedAt + (c.ms ?? 0)))
    const nowText = runningCall
      ? `${runningCall.label} 중  ${duration(now - runningCall.startedAt)}`
      : `다음 할 일 정리 중  ${duration(now - lastTouch)}`

    const phaseRow = (
      <Text>
        {PHASES.map(([p, name]) =>
          isRunning && p === current ? (
            <Text bold color="warning">{`▸${name}  `}</Text>
          ) : seen.has(p) ? (
            <Text color="success">{`✓${name}  `}</Text>
          ) : (
            <Text dimColor>{`◦${name}  `}</Text>
          ),
        )}
      </Text>
    )

    let used = 0
    let head: JSX.Element
    if (isRunning) {
      used += rowLines('지금', nowText) + 3
      head = (
        <Box flexDirection="column">
          {Row('지금', nowText, { bold: true })}
          <Progress label="진행" value={pct} max={100} valueText={pctText} />
          {phaseRow}
        </Box>
      )
    } else if (story) {
      // 카드: 굵은 제목 아래 한 줄에 하나씩(쉼표로 잇지 않음). 확인한 것은 종류별 개수를 두 칸씩.
      const inner = cols - 2
      const lists: [string, string[]][] = (
        [
          ['요청', [firstSentence(story.request) || '(이어서 한 작업)']],
          ['쓴 스킬', story.skills],
          ['따른 지침', story.guides],
          ['판단 근거', story.basis],
        ] as [string, string[]][]
      ).filter(([, items]) => items.length > 0)
      const checks: { glyph: string; text: string; color?: 'success' | 'error' }[] = story.unverified
        ? [{ glyph: '✗', text: '바꾼 뒤 검증하지 않았습니다', color: 'error' }]
        : story.checks.length > 0
          ? story.checks.map(c =>
              c.endsWith('실패') ? { glyph: '✗', text: c, color: 'error' } : { glyph: '✓', text: c, color: 'success' },
            )
          : [{ glyph: '◦', text: '검증할 변경 없음' }]
      const half = Math.floor(inner / 2)
      used +=
        3 +
        lists.reduce((n, [, items]) => n + 1 + items.reduce((k, x) => k + linesOf(x, inner), 0), 0) +
        (story.sources.length > 0 ? 1 + Math.ceil(story.sources.length / 2) : 0) +
        1 +
        checks.length
      const Items = (items: string[]) => Indent(2, <Box flexDirection="column">{items.map(x => <Text wrap="wrap">{x}</Text>)}</Box>)
      head = (
        <Box flexDirection="column">
          <Text>
            <Text bold>작업 설명</Text>
            <Text dimColor>
              {'  '}
              {DONE_LABEL[story.status]}
              {story.ms !== undefined ? `, ${duration(story.ms)}` : ''}
            </Text>
          </Text>
          {lists.map(([name, items]) => (
            <Box flexDirection="column">
              {Section(name)}
              {Items(items)}
            </Box>
          ))}
          {story.sources.length > 0 && (
            <Box flexDirection="column">
              {Section('확인한 것')}
              <Box flexDirection="row" flexWrap="wrap" paddingLeft={2}>
                {story.sources.map(x => (
                  <Box width={half}>
                    <Text>{x}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          {Section('검증')}
          {checks.map(c =>
            Indent(
              2,
              <Text wrap="wrap">
                <Text color={c.color} dimColor={c.color === undefined}>
                  {c.glyph}
                </Text>{' '}
                {c.text}
              </Text>,
            ),
          )}
          {phaseRow}
          <Text dimColor>/trace 설명 으로 글로 받기</Text>
        </Box>
      )
    } else {
      used += 1
      head = <Text dimColor>아직 작업이 없습니다. 요청을 보내면 여기에 과정이 흐릅니다.</Text>
    }

    const activeAgents = agents.filter(s => s.status === 'running')
    const lastOf = (id?: string) => (id === undefined ? undefined : all.filter(c => c.agent === id).at(-1))
    const bgRows = activeAgents.length > 0 || bgs.length > 0 ? 2 + activeAgents.length * 2 + bgs.length : 0
    const hudRows = hud !== '' ? 2 : 0
    used += bgRows + hudRows

    // 흐름: 큰 단계([n/m] 문장) 아래에 표시 없는 문장(세부 단계)을 묶는다.
    // 표시가 하나도 없는 작업에선 문장마다 큰 단계.
    const byGroup = (n: number) => mine.filter(c => c.group === n)
    const orphan = byGroup(0)
    const shown: Group[] = [...(orphan.length > 0 ? [{ n: 0, title: '(설명 없이 시작)', tools: [] }] : []), ...gs]
    type Major = { lead: Group; subs: Group[]; label: string }
    const majors: Major[] = []
    let marked = false
    for (const g of shown) {
      const prev = majors.at(-1)
      if (g.n !== 0 && !g.step && marked && prev) prev.subs.push(g)
      else {
        if (g.step) marked = true
        majors.push({ lead: g, subs: [], label: g.step ? groupLabel(g) : g.n === 0 ? '' : `(${majors.length + 1})` })
      }
    }
    const refOf = new Map<number, string>()
    for (const m of majors) for (const g of [m.lead, ...m.subs]) refOf.set(g.n, m.label)

    // 근거: 판단에 쓴 것(커밋 · 외부 · 지침 · 스킬)만
    const kinds = [...ev]
      // 종류 순서대로, 같은 종류 안에선 나중 단계(최근에 찾은 것)부터
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.group - a.group)
      .slice(0, 4)
    const pending = isRunning && step ? Math.max(0, step.m - step.n) : 0
    let budget = Math.max(4, rows - used - 3 - (pending > 0 ? 1 : 0) - (kinds.length > 0 ? kinds.length + 2 : 0))
    // 끝나면 작업 설명 카드에 근거가 있으니 아래 칸은 작업 중에만
    const showEvidence = isRunning && kinds.length > 0 && budget >= 4
    if (!showEvidence && kinds.length > 0) budget += kinds.length + 2

    const blocks: JSX.Element[] = []
    let hidden = 0
    majors
      .slice()
      .reverse()
      .forEach((m, i) => {
        const members = [m.lead, ...m.subs]
        const items = mine.filter(c => members.some(g => g.n === c.group))
        const isNewest = i === 0
        const isLive = isNewest && isRunning
        const isOpen = open.includes(m.lead.n)
        const failed = items.filter(c => c.status === 'error' || c.status === 'denied').length
        const glyph = isLive ? '▸' : '✓'
        const headText = `${glyph} ${m.label ? `${m.label} ` : ''}${m.lead.title}`
        const live = isLive ? items.find(c => c.status === 'running') : undefined
        const latestSub = isLive ? m.subs.at(-1) : undefined
        const doneItems = items.filter(c => c.status !== 'running')
        const summary = [
          countActions(doneItems.map(c => c.src)).join(', '),
          m.subs.length > 0 && !isLive ? `세부 단계 ${m.subs.length}개` : '',
          failed > 0 ? `실패 ${failed}` : '',
        ]
          .filter(Boolean)
          .join(', ')
        // 펼침: 세부 단계 제목 + 동작 하나하나(최근 20줄)
        const detail: JSX.Element[] = []
        if (isOpen) {
          for (const g of members) {
            if (g !== m.lead) detail.push(Indent(4, <Text wrap="wrap">↳ {g.title}</Text>))
            for (const c of byGroup(g.n))
              detail.push(
                Indent(
                  g === m.lead ? 4 : 6,
                  <Text wrap="wrap">
                    <Text color={COLOR[c.status]}>{ICON[c.status]}</Text> {c.label}
                    {c.status === 'error' ? ' 실패' : c.status === 'denied' ? ' 막힘' : ''}
                    {c.target !== undefined && <Text dimColor>{`  ${c.target}`}</Text>}
                  </Text>,
                ),
              )
          }
        }
        const shownDetail = detail.slice(-20)
        const need =
          linesOf(headText, cols - 3) +
          (latestSub ? linesOf(`↳ ${latestSub.title}`, cols - 4) : 0) +
          (live ? linesOf(`⊷ ${live.label} 중 00초`, cols - 4) : 0) +
          (!isOpen && summary !== '' ? 1 : 0) +
          shownDetail.length
        if (!isNewest && budget - need < 0) {
          hidden += 1
          return
        }
        budget -= need
        blocks.unshift(
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button
                plain
                dimColor
                key={`step-${m.lead.n}`}
                onPress={async () => {
                  await update($, opened, list =>
                    list.includes(m.lead.n) ? list.filter(x => x !== m.lead.n) : [...list, m.lead.n],
                  )
                }}
              >
                {isOpen ? '-' : '+'}
              </Button>
              <Box paddingLeft={1} flexShrink={1}>
                <Text wrap="wrap" bold={isNewest} dimColor={!isNewest && !isOpen}>
                  <Text color={isLive ? 'warning' : 'success'}>{glyph}</Text> {m.label ? `${m.label} ` : ''}
                  {m.lead.title}
                </Text>
              </Box>
            </Box>
            {latestSub && Indent(4, <Text wrap="wrap">↳ {latestSub.title}</Text>)}
            {live &&
              Indent(
                4,
                <Text wrap="wrap">
                  <Text color="warning">⊷</Text> {live.label} 중 <Text dimColor>{duration(now - live.startedAt)}</Text>
                </Text>,
              )}
            {!isOpen &&
              summary !== '' &&
              Indent(
                4,
                <Text dimColor wrap="wrap">
                  {isLive ? `지금까지 ${summary}` : summary}
                </Text>,
              )}
            {shownDetail}
          </Box>,
        )
      })

    return (
      <Box flexDirection="column" width={cols}>
        {head}
        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {Section('흐름')}
            {hidden > 0 && Indent(2, <Text dimColor>이전 단계 {hidden}개</Text>)}
            {blocks}
            {pending > 0 && Indent(2, <Text dimColor>◦ 남은 단계 {pending}개</Text>)}
            <Text dimColor>+ 를 누르면 단계 안의 세부 동작이 펼쳐집니다</Text>
          </Box>
        )}
        {bgRows > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {Section('백그라운드')}
            {activeAgents.map(s => (
              <Box flexDirection="column">
                <Text wrap="wrap">
                  <Text color="warning">⊷</Text> {agentName(s.type)}: {s.description}
                </Text>
                {lastOf(s.id) && Indent(2, <Text dimColor wrap="wrap">↳ {lastOf(s.id)?.label}</Text>)}
              </Box>
            ))}
            {bgs.map(b => (
              <Text wrap="wrap">
                <Text color="warning">⊷</Text> {b.label}
              </Text>
            ))}
          </Box>
        )}
        {showEvidence && (
          <Box flexDirection="column" marginTop={1}>
            {Section('근거')}
            {kinds.map(x => (
              <Text wrap="wrap">
                [{TAG[x.kind]}] {x.text}
                {x.count > 1 ? ` x${x.count}` : ''} {x.group > 0 ? (refOf.get(x.group) ?? '') : ''}
              </Text>
            ))}
          </Box>
        )}
        {hud !== '' && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {hud}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
