import { t } from '../../SharedUI/i18n.mjs'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCheck, ChevronRight, Compass, Move, RotateCcw, Smartphone, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import {
  initialTutorialState,
  tutorialCommandForKey,
  tutorialInputLabels,
  tutorialLessons,
  tutorialReducer,
  type TutorialOutcome,
} from './tutorialState'
import './remoteTutorial.css'
import { uiSounds } from './uiSounds'

const gestureUrl = (name: string) => new URL(`./assets/tutorial/${name}.svg`, document.baseURI).href
const commandIcons = { right: ArrowRight, down: ArrowDown, left: ArrowLeft, up: ArrowUp, enter: Check, back: RotateCcw }

function GestureArt({ gesture, label, full = false, simpleUi = false }: { gesture: string; label: string; full?: boolean; simpleUi?: boolean }) {
  const asset = full ? `${gesture}-full` : gesture
  const stillAsset = simpleUi ? `simpleUI/${asset}-still` : `${asset}-still`
  return (
    <picture className={full ? 'tutorial-person' : 'tutorial-hand'}>
      <source media="(prefers-reduced-motion: reduce)" srcSet={gestureUrl(stillAsset)} />
      <img key={asset} src={gestureUrl(simpleUi ? stillAsset : asset)} alt={label} draggable={false} />
    </picture>
  )
}

export default function RemoteTutorial({ onExit, onComplete, simpleUi = false }: { onExit: (outcome: TutorialOutcome) => void; onComplete?: () => void; simpleUi?: boolean }) {
  const [state, dispatch] = useReducer(tutorialReducer, undefined, initialTutorialState)
  const root = useRef<HTMLDivElement>(null)
  const deliveredOutcome = useRef(false)
  const lesson = tutorialLessons[state.step]
  const CommandIcon = commandIcons[lesson.command]
  const success = state.feedback === 'success'
  const isMenu = state.exitOpen || state.phase !== 'practice'
  const completedSteps = state.phase === 'complete' ? 6 : state.phase === 'welcome' ? 0 : state.step + Number(success)
  const focusId = isMenu ? `choice-${state.choice}` : 'practice'
  const previousSoundState = useRef(state)

  useEffect(() => {
    const previous = previousSoundState.current
    previousSoundState.current = state
    if (previous === state) return
    if (state.outcome && !previous.outcome) uiSounds.play('back')
    else if (state.exitOpen !== previous.exitOpen) uiSounds.play(state.exitOpen ? 'open' : 'close')
    else if (state.feedback === 'success' && previous.feedback !== 'success') uiSounds.play('success')
    else if (state.feedback === 'retry' && (previous.feedback !== 'retry' || state.lastInput !== previous.lastInput)) uiSounds.play('error')
    else if (state.phase === 'practice' && previous.phase !== 'practice') uiSounds.play('select')
    else if (isMenu && state.choice !== previous.choice) uiSounds.play('focus')
  }, [isMenu, state])

  useEffect(() => {
    // Android emits a custom remote notification AND a bubbling keyboard event.
    // Consume only the latter so each physical gesture advances at most once.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat) return
      if (event.key === 'Tab' && isMenu) {
        dispatch({ type: 'choose', choice: state.choice === 0 ? 1 : 0 })
        return
      }
      const command = tutorialCommandForKey(event.key)
      if (command) dispatch({ type: 'command', command })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isMenu, state.choice])

  useLayoutEffect(() => {
    const target = root.current?.querySelector<HTMLElement>(`[data-tutorial-focus="${focusId}"]`)
    if (!target) return
    root.current?.querySelectorAll('[data-spatial-focus]').forEach((element) => element.removeAttribute('data-spatial-focus'))
    target.setAttribute('data-spatial-focus', 'true')
    target.focus({ preventScroll: true })
  }, [focusId, state.phase, state.step, success, state.exitOpen])

  useEffect(() => {
    if (!success || state.exitOpen) return
    const timer = window.setTimeout(() => dispatch({ type: 'advance' }), 1100)
    return () => window.clearTimeout(timer)
  }, [success, state.step, state.exitOpen])

  useEffect(() => {
    if (!state.outcome || deliveredOutcome.current) return
    deliveredOutcome.current = true
    onExit(state.outcome)
  }, [onExit, state.outcome])

  useEffect(() => {
    if (state.phase === 'complete') onComplete?.()
  }, [onComplete, state.phase])

  const choices = (primary: string, secondary: string) => (
    <div className="tutorial-actions">
      {[primary, secondary].map((label, index) => (
        <button
          key={index}
          type="button"
          className={`tutorial-button ${index === 0 ? 'tutorial-button--primary' : ''}`}
          data-tutorial-focus={`choice-${index}`}
          data-focusable="true"
          tabIndex={state.choice === index ? 0 : -1}
          onFocus={() => dispatch({ type: 'choose', choice: index as 0 | 1 })}
          onClick={() => dispatch({ type: 'select', choice: index as 0 | 1 })}
        >
          {label}{index === 0 && <ChevronRight size={22} />}
        </button>
      ))}
    </div>
  )

  return (
    <div ref={root} className={`remote-tutorial is-${state.phase} ${success ? 'is-success' : ''}`} data-tutorial-step={state.phase === 'practice' ? lesson.command : state.phase}>
      <div className="tutorial-floor" aria-hidden="true" />
      <div className="tutorial-shell" inert={state.exitOpen}>
        <header className="tutorial-header">
          <div className="tutorial-brand"><span><Compass size={25} /></span><strong>tachi</strong><i /><span>{t("遥控入门")}</span></div>
        </header>

        {state.phase === 'welcome' ? (
          <main className="tutorial-welcome">
            <div className="tutorial-welcome__copy">
              <span className="tutorial-eyebrow"><i />  {t("你的第一堂遥控课")}</span>
              <h1>{t("目光留在这里。")}<br /><em>{t("操作交给拇指。")}</em></h1>
              <p>{t("拿好手机，打开触控板。")}<br />{t("跟着眼镜里的提示，用六个小动作学会遥控。")}</p>
              <div className="tutorial-welcome__facts"><span><Smartphone size={19} />  {t("单手就能操作")}</span><span><Sparkles size={19} />  {t("大约 1 分钟")}</span></div>
              {choices(t("单击，开始练习"), t("稍后再学"))}
              <small className="tutorial-choice-hint">{t("左右滑动选择 · 单击确认 · 双击跳过")}</small>
              <small className="tutorial-choice-hint">{t("手柄：方向键／左摇杆移动，下方键确认，右方键跳过教学")}</small>
            </div>
            <div className="tutorial-welcome__art">
              <div className="tutorial-orbit" aria-hidden="true" />
              <GestureArt gesture="single-tap" label={t("戴着眼镜，单手握住手机，用拇指单击触控板，开始教学")} full simpleUi={simpleUi} />
              <div className="tutorial-art-caption"><span />  {t("看着眼镜里的画面，试着单击手机")}</div>
            </div>
          </main>
        ) : state.phase === 'complete' ? (
          <main className="tutorial-complete">
            <div className="tutorial-complete__seal"><CheckCheck size={52} strokeWidth={1.5} /></div>
            <span className="tutorial-eyebrow">{t("六个动作，全部点亮")}</span>
            <h1>{t("你的私人影院，")}<em>{t("现在听你的。")}</em></h1>
            <p>{t("去挑一部喜欢的。遥控已经在你手里。")}</p>
            <div className="tutorial-recap">
              <div><Move size={26} /><strong>{t("滑动")}</strong><span>{t("移动焦点")}</span></div>
              <div><Check size={26} /><strong>{t("单击")}</strong><span>{t("确认选择")}</span></div>
              <div><RotateCcw size={26} /><strong>{t("双击")}</strong><span>{t("返回上一级")}</span></div>
            </div>
            {choices(t("开始浏览"), t("再练一次"))}
            <small className="tutorial-choice-hint">{t("随时可从眼镜端侧栏「遥控教学」重新练习")}</small>
          </main>
        ) : (
          <main className="tutorial-lesson">
            <section className="tutorial-instruction" aria-labelledby="tutorial-title">
              <span className="tutorial-eyebrow"><span>{String(state.step + 1).padStart(2, '0')} / 06</span>{state.step < 4 ? t("移动焦点") : t("选择与返回")}</span>
              <h1 id="tutorial-title">{lesson.title}</h1>
              <p>{lesson.description}</p>
              <div className="tutorial-demonstration">
                <GestureArt gesture={lesson.gesture} label={t("拇指{0}手机触控板的示范", { 0: tutorialInputLabels[lesson.command] })} simpleUi={simpleUi} />
                <div className="tutorial-gesture-label"><span><CommandIcon size={30} /></span><strong>{tutorialInputLabels[lesson.command]}</strong><small>{t("在手机触控板上操作")}</small></div>
              </div>
              <div className={`tutorial-feedback ${state.feedback}`} role="status" aria-live="polite">
                {success ? <Check size={22} /> : <span className="tutorial-feedback__dot" />}
                <span>{success ? lesson.success : state.feedback === 'retry' && state.lastInput
                  ? t("收到{0}，这次试试{1}。", { 0: tutorialInputLabels[state.lastInput], 1: tutorialInputLabels[lesson.command] })
                  : lesson.hint}</span>
              </div>
            </section>

            <section className="tutorial-practice" aria-label={t("遥控练习空间")}>
              <div className="tutorial-practice__header"><span><i />  {t("练习空间")}</span><small>{state.step < 4 ? t("让光点抵达目标") : state.step === 4 ? t("选中的卡片，可以打开") : t("打开的页面，可以返回")}</small></div>
              {state.step < 4 ? (
                <div className="tutorial-grid" role="group" aria-label={t("方向练习区")}>
                  {Array.from({ length: 9 }, (_, index) => {
                    const focused = index === (success ? lesson.to : lesson.from)
                    const target = index === lesson.to
                    return (
                      <div
                        key={index}
                        className={`tutorial-cell ${focused ? 'is-current' : ''} ${target ? 'is-target' : ''}`}
                        tabIndex={focused ? 0 : -1}
                        data-tutorial-focus={focused ? 'practice' : undefined}
                        data-focusable={focused ? 'true' : undefined}
                        aria-label={focused ? t("当前光点") : target ? t("发光目标") : undefined}
                      >
                        {focused ? <><span className="tutorial-light"><Check size={27} /></span><small>{success ? t("已抵达") : t("你在这里")}</small></>
                          : target ? <><CommandIcon size={30} /><small>{t("移到这里")}</small></> : <span className="tutorial-cell__point" />}
                      </div>
                    )
                  })}
                </div>
              ) : (state.step === 4 && !success) || (state.step === 5 && success) ? (
                <div className="tutorial-card-scene">
                  <button type="button" data-tutorial-focus="practice" data-focusable="true" className="tutorial-movie-card" onClick={() => dispatch({ type: 'command', command: 'enter' })}>
                    <div className="tutorial-movie-art" aria-hidden="true"><div className="tutorial-planet" /><span>BEYOND<br />THE BLUE</span></div>
                    <div className="tutorial-movie-card__copy"><span><small>{t("你的第一张练习卡片")}</small><strong>{t("蓝色之外")}</strong></span><ChevronRight size={25} /></div>
                  </button>
                  <span className="tutorial-stage-note">{success ? t("已经回到卡片列表") : t("白色边框，就是你当前的选择")}</span>
                </div>
              ) : (
                <div className="tutorial-detail-scene">
                  <div className="tutorial-detail">
                    <div className="tutorial-detail__art" aria-hidden="true"><div className="tutorial-planet" /></div>
                    <span className="tutorial-detail__badge"><Check size={17} />  {t("卡片已打开")}</span>
                    <h2>{t("蓝色之外")}</h2><p>{t("每一段旅程，都从一次轻触开始。")}</p>
                    <div tabIndex={0} data-tutorial-focus="practice" data-focusable="true" className="tutorial-return-target"><RotateCcw size={23} /><span>{t("双击触控板，回到卡片")}</span></div>
                  </div>
                  <span className="tutorial-stage-note">{t("这是练习用的详情页，放心试一试")}</span>
                </div>
              )}
              <div className={`tutorial-stage-status ${success ? 'is-done' : ''}`} aria-hidden="true">{success ? <Check size={18} /> : <span className="tutorial-status-ring" />}{success ? t("完成！") : t("等待你的操作")}</div>
            </section>
          </main>
        )}

        <footer className="tutorial-footer">
          <div className="tutorial-progress" aria-label={t("已完成 {0} 项，共 6 项", { 0: completedSteps })}>
            {tutorialLessons.map((item, index) => {
              const Icon = commandIcons[item.command]
              return <span key={item.command} className={`${index < completedSteps ? 'is-done' : ''} ${state.phase === 'practice' && index === state.step ? 'is-active' : ''}`} aria-label={tutorialInputLabels[item.command]}>{index < completedSteps ? <Check size={18} /> : <Icon size={18} />}</span>
            })}
            <small>{completedSteps} / 6</small>
          </div>
          <span className="tutorial-footer__hint">{state.phase === 'practice' ? state.step === 5 ? t("快速双击 · 返回练习卡片") : t("双击 · 暂停或退出教学") : t("滑动选择 · 单击确认")}</span>
        </footer>
      </div>

      {state.exitOpen && (
        <div className="tutorial-exit-layer">
          <section className="tutorial-exit" role="dialog" aria-modal="true" aria-labelledby="tutorial-exit-title">
            <span className="tutorial-exit__icon"><Compass size={35} /></span>
            <h2 id="tutorial-exit-title">{t("要先去看看吗？")}</h2>
            <p>{t("已完成")} {completedSteps}  {t("/ 6 个动作。")}<br />{t("随时可以从侧栏「遥控教学」重新开始。")}</p>
            {choices(t("继续练习"), t("退出教学"))}
            <small className="tutorial-choice-hint">{t("左右滑动选择 · 单击确认 · 双击继续练习")}</small>
          </section>
        </div>
      )}
    </div>
  )
}
