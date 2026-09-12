import { hasNativePlayback, NativePlayback, type PlaybackSurface } from './nativePlayback'
import { useNativeSbs } from './useNativeSbs'
import { useRealtimeSbs, DepthPreview } from './useRealtimeSbs'
import './realtimeSbs.css'
import { useLanguage } from './useLanguage'
import { getLocale, t } from '../../SharedUI/i18n.mjs'
import { parseSeekCommand } from '../../SharedUI/seekCommand.mjs'
import { latestWatchedEpisode, resumeProgress, watchedTime } from './watchProgress'
import AssSubtitles from './AssSubtitles'
import {
  ArrowDownUp,
  ArrowLeft,
  AudioLines,
  BookOpen,
  Captions,
  Check,
  ChevronRight,
  Delete as DeleteIcon,
  FastForward,
  Folder,
  Grid3X3,
  Heart,
  Home,
  Info,
  Keyboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  MonitorPlay,
  Move,
  MoveHorizontal,
  MoveVertical,
  Pause,
  Play,
  Pointer,
  RefreshCw,
  Rewind,
  RotateCcw,
  Search,
  Server,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Star,
  Subtitles,
  UserRound,
  Volume2,
  Volume1,
  VolumeX,
  X,
} from 'lucide-react'
import type Hls from 'hls.js'
import { applyUiTheme, normalizeUiTheme, type UiTheme } from '../../SharedUI/theme.mjs'
import { suspendHiddenAnimations } from '../../SharedUI/hiddenAnimations.mjs'
import {
  type CSSProperties,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  featured as demoFeatured,
  type MediaItem,
  type MediaShelf,
} from './data'
import type {
  DetailSnapshot,
  PlaybackPlan,
  PlaybackSelection,
} from './jellyfin'
import { postNativeMessage, requestUiPreference } from './runtime'
import { normalizeSubtitleSize, subtitleFontSize, type SubtitleSize } from '../../SharedUI/subtitles.mjs'
import GlassesSettings from './GlassesSettings'
import { uiSounds, type UiSound } from './uiSounds'
import RemoteTutorial from './RemoteTutorial'
import VideoInfoOverlay from './VideoInfoOverlay'
import SystemClock from './SystemClock'
import type { PlaybackInfoSource } from './playbackInfo'
import { hasSeenRemoteTutorial, rememberRemoteTutorial, type TutorialOutcome } from './tutorialState'
import { LoadingCards, Toast, usePresence, type FeedbackTone, type ToastMessage } from './feedback'
import {
  buildSeriesIndex,
  parseSeriesQuery,
  searchSeries,
  type SeriesIndexEntry,
} from './seriesSearch'
import {
  useJellyfin,
  type JellyfinUiStatus,
  type SeriesIndexStatus,
} from './useJellyfin'

type Page = 'home' | 'browse' | 'favorites' | 'search' | 'detail' | 'player' | 'tutorial' | 'settings'
type Direction = 'up' | 'down' | 'left' | 'right'
type HomeFocusRegion = 'hero' | 'shelves'
type PlaybackRequest = {
  item: MediaItem
  startPositionTicks: number
  key: number
}

const BROWSE_BATCH_SIZE = 12
const focusableSelector = '[data-focusable="true"]:not([disabled])'
const spatialFocusSelector = '[data-spatial-focus="true"]'
let sideNavigationReturnTarget: HTMLElement | null = null

function visibleFocusables(rects?: Map<HTMLElement, DOMRect>) {
  return Array.from(document.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    const rect = element.getBoundingClientRect()
    rects?.set(element, rect)
    if (rect.width <= 2 || rect.height <= 2) return false
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}

function clearSpatialFocus(except?: HTMLElement | null) {
  document.querySelectorAll<HTMLElement>(spatialFocusSelector).forEach((element) => {
    if (element !== except) element.removeAttribute('data-spatial-focus')
  })
}

function currentSpatialFocus() {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (active?.matches(focusableSelector)) return active

  // A phone-side pointer gesture can leave the glasses document with body as activeElement.
  // Keep the glasses-owned spatial marker as the logical focus across that boundary.
  const marked = document.querySelector<HTMLElement>(spatialFocusSelector)
  return marked?.matches(focusableSelector) ? marked : null
}

function focusSpatialElement(element?: HTMLElement | null, options: FocusOptions = { preventScroll: true }) {
  if (!element) return false
  clearSpatialFocus(element)
  element.setAttribute('data-spatial-focus', 'true')
  element.focus(options)
  return document.activeElement === element || element.matches(spatialFocusSelector)
}

function soundNavigation(direction: Direction, action: () => void, boundary = true) {
  const previous = currentSpatialFocus()
  action()
  const next = currentSpatialFocus()
  if (next && next !== previous) {
    uiSounds.resetBoundary()
    uiSounds.play('focus')
  } else if (boundary && previous) {
    uiSounds.playBoundaryOnce(previous, direction)
  }
}

function moveFocus(direction: Direction) {
  // Geometry is valid only for this key event; scrolling and animated transforms
  // must be measured again on the next event.
  const rects = new Map<HTMLElement, DOMRect>()
  const nodes = visibleFocusables(rects)
  if (!nodes.length) return

  const current = currentSpatialFocus()
  if (!current || !nodes.includes(current)) {
    const firstContent = nodes.find((node) => !node.closest('.side-navigation'))
    focusSpatialElement(document.querySelector<HTMLElement>('[data-autofocus="true"]') ?? firstContent ?? nodes[0])
    return
  }

  const source = rects.get(current)!
  const sx = source.left + source.width / 2
  const sy = source.top + source.height / 2
  const currentInNavigation = Boolean(current.closest('.side-navigation'))
  const navigationNodes = nodes.filter((node) => Boolean(node.closest('.side-navigation')))
  const contentNodes = nodes.filter((node) => !node.closest('.side-navigation'))

  const focusTarget = (candidate: HTMLElement) => {
    const rail = candidate.closest<HTMLElement>('.episode-rail')
    const entry = rail?.dataset.resumeEntry === 'pending' && !current.closest('.episode-rail')
      ? rail.querySelector<HTMLElement>('[data-episode-entry="true"]') : null
    const node = entry ?? candidate
    if (rail) rail.dataset.resumeEntry = 'done'
    focusSpatialElement(node)
    if (node.closest('.side-navigation')) return

    const playerPage = node.closest<HTMLElement>('.player-page')
    if (playerPage) {
      playerPage.scrollLeft = 0
      playerPage.scrollTop = 0

      const trackList = node.closest<HTMLElement>('.track-list')
      if (!trackList) return

      const targetRect = node.getBoundingClientRect()
      const listRect = trackList.getBoundingClientRect()
      const focusInset = 6
      const scrollDelta = targetRect.top < listRect.top + focusInset
        ? targetRect.top - listRect.top - focusInset
        : targetRect.bottom > listRect.bottom - focusInset
          ? targetRect.bottom - listRect.bottom + focusInset
          : 0

      if (scrollDelta) {
        trackList.scrollTo({
          top: trackList.scrollTop + scrollDelta,
          behavior: motionScrollBehavior(),
        })
      }
      return
    }

    if (direction === 'up' && node.closest('.hero-section')) {
      window.scrollTo({ top: 0, behavior: motionScrollBehavior() })
      return
    }

    const episodeSection = node.closest<HTMLElement>('.episode-section')
    if (episodeSection) {
      const episodeRail = node.closest<HTMLElement>('.episode-rail')
      if (episodeRail) {
        const targetRect = node.getBoundingClientRect()
        const railRect = episodeRail.getBoundingClientRect()
        const horizontalDelta = targetRect.left + targetRect.width / 2
          - (railRect.left + railRect.width / 2)
        episodeRail.scrollTo({
          left: episodeRail.scrollLeft + horizontalDelta,
          behavior: motionScrollBehavior(),
        })
      }

      const topInset = Math.max(24, Math.min(48, window.innerHeight * .04))
      const sectionTop = window.scrollY + episodeSection.getBoundingClientRect().top
      window.scrollTo({
        top: Math.max(0, sectionTop - topInset),
        behavior: motionScrollBehavior(),
      })
      return
    }

    node.scrollIntoView({
      behavior: motionScrollBehavior(),
      block: direction === 'up' || direction === 'down' ? 'center' : 'nearest',
      inline: 'center',
    })
  }

  if (!currentInNavigation && direction === 'up') {
    const currentShelf = current.closest('.home-page .shelf')
    const firstShelf = document.querySelector('.home-page .shelf')
    const heroPrimary = document.querySelector<HTMLElement>('.home-page .hero-actions .focus-button--primary')
    if (currentShelf && currentShelf === firstShelf && heroPrimary) {
      focusTarget(heroPrimary)
      return
    }
  }

  if (direction === 'right' && currentInNavigation && sideNavigationReturnTarget?.isConnected) {
    focusTarget(sideNavigationReturnTarget)
    sideNavigationReturnTarget = null
    return
  }

  const candidates = currentInNavigation
    ? direction === 'right' ? contentNodes : navigationNodes
    : contentNodes

  let best: { node: HTMLElement; score: number } | null = null

  for (const node of candidates) {
    if (node === current) continue
    const rect = rects.get(node)!
    const tx = rect.left + rect.width / 2
    const ty = rect.top + rect.height / 2
    const dx = tx - sx
    const dy = ty - sy
    const primary = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
    if (primary <= 8) continue

    if (!currentInNavigation && (direction === 'left' || direction === 'right')) {
      const verticalGap = Math.max(0, Math.max(source.top, rect.top) - Math.min(source.bottom, rect.bottom))
      const horizontalRowTolerance = Math.max(source.height, rect.height) * .5
      if (verticalGap > horizontalRowTolerance) continue
    }

    const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    const sourceSpan = direction === 'left' || direction === 'right' ? source.height : source.width
    const targetSpan = direction === 'left' || direction === 'right' ? rect.height : rect.width
    const overlapAllowance = (sourceSpan + targetSpan) / 2
    const alignmentPenalty = secondary > overlapAllowance ? secondary * 2.4 : secondary * 0.45
    const score = primary + alignmentPenalty + Math.hypot(dx, dy) * 0.06
    if (!best || score < best.score) best = { node, score }
  }

  if (!best && direction === 'left' && !currentInNavigation) {
    sideNavigationReturnTarget = current
    const navigationTarget = document.querySelector<HTMLElement>('.side-navigation .main-nav .is-active')
      ?? document.querySelector<HTMLElement>('.side-navigation .main-nav [data-focusable="true"]')
    if (navigationTarget) focusTarget(navigationTarget)
    return
  }

  if (best) focusTarget(best.node)
}

function movePlayerFocus(direction: Direction) {
  const current = currentSpatialFocus()
  if (!current) return false

  const progress = document.querySelector<HTMLElement>('.player-progress__bar')
  const controlButtons = Array.from(document.querySelectorAll<HTMLElement>(`.player-control-row ${focusableSelector}`))
  const controlIndex = controlButtons.indexOf(current)

  if (direction === 'down' && current === progress) {
    focusSpatialElement(document.querySelector<HTMLElement>('.player-play:not([disabled])') ?? controlButtons[0])
    return true
  }

  if (direction === 'up' && controlIndex >= 0) {
    focusSpatialElement(progress)
    return true
  }

  if ((direction === 'left' || direction === 'right') && controlIndex >= 0) {
    const offset = direction === 'left' ? -1 : 1
    const nextIndex = Math.max(0, Math.min(controlButtons.length - 1, controlIndex + offset))
    focusSpatialElement(controlButtons[nextIndex])
    return true
  }

  return false
}

function focusSeriesSearchKeyboard(searchPage: HTMLElement) {
  const keys = Array.from(searchPage.querySelectorAll<HTMLElement>('[data-search-keyboard="true"]:not([disabled])'))
  const requestedId = searchPage.dataset.keyboardReturnId
  const target = keys.find((key) => key.dataset.searchFocusId === requestedId) ?? keys[0]
  return focusSpatialElement(target)
}

function moveSeriesSearchFocus(current: HTMLElement, direction: Direction) {
  const searchPage = current.closest<HTMLElement>('.series-search-page')
  if (!searchPage) return false

  const visibleEnabled = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const rows = Array.from(searchPage.querySelectorAll<HTMLElement>('[data-search-keyboard-row="true"]'))
    .map((row) => Array.from(row.querySelectorAll<HTMLElement>('[data-search-keyboard="true"]:not([disabled])')).filter(visibleEnabled))
    .filter((row) => row.length)
  const results = Array.from(searchPage.querySelectorAll<HTMLElement>('[data-search-result="true"]:not([disabled])'))
    .filter(visibleEnabled)
  const rowIndex = rows.findIndex((row) => row.includes(current))

  if (rowIndex >= 0) {
    const row = rows[rowIndex]
    const columnIndex = row.indexOf(current)
    searchPage.dataset.keyboardReturnId = current.dataset.searchFocusId ?? ''

    if (direction === 'left' || direction === 'right') {
      const nextIndex = columnIndex + (direction === 'right' ? 1 : -1)
      if (nextIndex < 0) return false
      const target = row[Math.min(row.length - 1, nextIndex)]
      focusSpatialElement(target)
      target.scrollIntoView({ behavior: motionScrollBehavior(), block: 'nearest', inline: 'center' })
      return true
    }

    if (direction === 'down') {
      const target = results.find((result) => result.dataset.previewed === 'true') ?? results[0]
      if (target) {
        focusSpatialElement(target)
        target.scrollIntoView({ behavior: motionScrollBehavior(), block: 'nearest', inline: 'nearest' })
      }
      return true
    }
    return true
  }

  const resultIndex = results.indexOf(current)
  if (resultIndex < 0) return false
  const source = current.getBoundingClientRect()
  const sourceX = source.left + source.width / 2
  const sourceY = source.top + source.height / 2
  const candidates = results.flatMap((result) => {
    if (result === current) return []
    const rect = result.getBoundingClientRect()
    const dx = rect.left + rect.width / 2 - sourceX
    const dy = rect.top + rect.height / 2 - sourceY
    const primary = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
    if (primary <= 4) return []
    if ((direction === 'left' || direction === 'right') && Math.abs(dy) > Math.max(source.height, rect.height) * .55) return []
    const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    return [{ result, score: primary + secondary * 2.2 }]
  }).sort((left, right) => left.score - right.score)
  const next = candidates[0]?.result
  if (!next) {
    return direction === 'left' || direction === 'up'
      ? focusSeriesSearchKeyboard(searchPage)
      : true
  }
  focusSpatialElement(next)
  next.scrollIntoView({ behavior: motionScrollBehavior(), block: 'nearest', inline: 'nearest' })
  return true
}

function motionScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
}

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ')
}

type FocusButtonProps = {
  sound?: UiSound | 'none'
  children: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
  variant?: 'primary' | 'ghost' | 'glass' | 'round' | 'chip' | 'danger'
  className?: string
  active?: boolean
  autoFocusTarget?: boolean
  label?: string
  disabled?: boolean
  busy?: boolean
  progress?: number
  onClick?: () => void
  onFocus?: () => void
}

function FocusButton({
  sound,
  children,
  icon,
  trailing,
  variant = 'glass',
  className,
  active,
  autoFocusTarget,
  label,
  disabled,
  busy = false,
  progress,
  onClick,
  onFocus,
}: FocusButtonProps) {
  return (
    <button
      type="button"
      data-focusable="true"
      data-ui-sound={sound}
      data-autofocus={autoFocusTarget ? 'true' : undefined}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled && !busy}
      aria-disabled={disabled || busy || undefined}
      aria-busy={busy || undefined}
      className={cx('focus-button', `focus-button--${variant}`, active && 'is-active', className)}
      onClick={() => { if (!disabled && !busy) onClick?.() }}
      onFocus={onFocus}
    >
      {progress !== undefined && <span className="focus-button__progress" aria-hidden="true" style={{ width: `${progress}%` }} />}
      <span className="focus-button__lens" aria-hidden="true" />
      {icon && <span className="focus-button__icon">{icon}</span>}
      <span className="focus-button__label">{children}</span>
      {trailing && <span className="focus-button__trailing">{trailing}</span>}
    </button>
  )
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={cx('wordmark', compact && 'wordmark--compact')} aria-label={t("tachi（塔奇）")}>
      <span className="wordmark__spark" />
      <span className="wordmark__name">tachi</span>
      {!compact && <span className="wordmark__sub">{t("塔奇 / MEDIA")}</span>}
    </span>
  )
}

function AmbientBackground({
  simpleUi = false,
  tone,
  imageUrl,
  dim = 0.45,
  homeCover = false,
  preview = false,
}: {
  simpleUi?: boolean
  tone: number
  imageUrl?: string
  dim?: number
  homeCover?: boolean
  preview?: boolean
}) {
  const fallbackImage = new URL(
    tone % 3 === 1 ? './assets/monochrome-flow.png' : './assets/crystal-flow.png',
    document.baseURI,
  ).href
  const [artwork, setArtwork] = useState({ current: '', previous: '' })
  useEffect(() => {
    if (simpleUi) return
    // Keep the current cover until its replacement loads; ignore late focus requests.
    let cancelled = false
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      setArtwork((current) => current.current === image.src
        ? current : { current: image.src, previous: current.current })
    }
    image.onerror = () => {
      if (!cancelled && image.src !== fallbackImage) image.src = fallbackImage
    }
    image.src = imageUrl ?? fallbackImage
    return () => { cancelled = true }
  }, [fallbackImage, imageUrl, simpleUi])
  const style = {
    '--tone': imageUrl ? '0deg' : `${tone * 31}deg`,
    '--drift-x': `${42 + (tone % 5) * 8}%`,
    '--dim': dim,
  } as CSSProperties

  if (simpleUi) return (
    <div className="ambient ambient--home-cover" aria-hidden="true">
      {imageUrl && <div className="ambient__image" style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }} />}
      <div className="ambient__veil" />
    </div>
  )

  return (
    <div className={cx('ambient', homeCover && 'ambient--home-cover', preview && 'ambient--preview')} style={style} aria-hidden="true">
      <div className="ambient__artwork">
        {artwork.previous && <div key={artwork.previous} className="ambient__image ambient__image--previous" style={{ backgroundImage: `url(${JSON.stringify(artwork.previous)})` }} />}
        {artwork.current && <div key={artwork.current} className="ambient__image"
          style={{ backgroundImage: `url(${JSON.stringify(artwork.current)})` }}
          onAnimationEnd={() => setArtwork((current) => ({ ...current, previous: '' }))} />}
      </div>
      <div className={`ambient__spectrum ambient__spectrum--${tone % 4}`} />
      <div className="ambient__veil" />
      <div className="ambient__grain" />
    </div>
  )
}

function ArtFrame({
  item,
  wide = false,
  className,
  children,
}: {
  item: MediaItem
  wide?: boolean
  className?: string
  children?: ReactNode
}) {
  const imageUrl = wide ? item.imageUrl : item.coverUrl ?? item.imageUrl
  const [loadedUrl, setLoadedUrl] = useState('')
  const [failedUrl, setFailedUrl] = useState('')
  const imageReady = Boolean(imageUrl && loadedUrl === imageUrl)
  const fallbackImage = new URL(
    item.art % 3 === 1 ? './assets/monochrome-flow.png' : './assets/crystal-flow.png',
    document.baseURI,
  ).href
  const style = {
    '--art-hue': imageReady ? '0deg' : `${item.art * 28}deg`,
    '--art-x': imageUrl ? '50%' : `${30 + (item.art % 5) * 14}%`,
    '--art-y': imageUrl ? '50%' : `${30 + (item.art % 4) * 15}%`,
    backgroundImage: `url(${fallbackImage})`,
  } as CSSProperties
  return (
    <div className={cx('art-frame', imageReady && 'art-frame--real', wide ? 'art-frame--wide' : 'art-frame--poster', className)}>
      <div className="art-frame__image" style={style} />
      {imageUrl && failedUrl !== imageUrl && (
        <img className={cx('art-frame__poster-image', imageReady && 'is-ready')} src={imageUrl}
          alt="" loading="lazy" decoding="async" draggable={false}
          onLoad={() => setLoadedUrl(imageUrl)} onError={() => setFailedUrl(imageUrl)} />
      )}
      <div className={`art-frame__orb art-frame__orb--${item.art % 4}`} />
      <div className="art-frame__flare" />
      <div className="art-frame__index">L/{String(item.art + 1).padStart(2, '0')}</div>
      <div className="art-frame__title">
        <span>{item.original ?? item.title.toUpperCase()}</span>
        <strong>{item.title}</strong>
      </div>
      {children}
    </div>
  )
}

function MediaIndicators({ item }: { item: MediaItem }) {
  const progress = Math.max(0, Math.min(100, item.progress ?? 0))
  return (
    <>
      {(item.watched || item.favorite) && (
        <span className="media-status-badges">
          {item.watched && <span className="is-watched"><Check size={14} />{t("已看")}</span>}
          {item.favorite && <span aria-label={t("已收藏")} title={t("已收藏")}><Heart size={14} fill="currentColor" /></span>}
        </span>
      )}
      {progress > 0 && !item.watched && (
        <span className="media-progress" aria-label={t("已观看 {0}%", { 0: Math.round(progress) })}>
          <i style={{ transform: `scaleX(${progress / 100})` }} />
        </span>
      )}
    </>
  )
}

type HeaderProps = {
  active: 'home' | 'browse' | 'favorites' | 'search' | 'settings' | 'none'
  onNavigate: (page: Page) => void
  onRefresh: () => void
  onExit: () => void
  serverName: string
  userName: string
  refreshing?: boolean
  minimal?: boolean
}

function PageHeader({ active, onNavigate, onRefresh, onExit, serverName, userName, refreshing = false, minimal = false }: HeaderProps) {
  return (
    <aside className={cx('page-header', 'side-navigation', minimal && 'side-navigation--minimal')} aria-label={t("全局导航")}>
      <span className="side-navigation__backdrop" aria-hidden="true" />
      <div className="side-navigation__inner">
        <FocusButton
          variant="ghost"
          className="logo-button side-navigation__brand"
          icon={<span className="side-navigation__brand-mark">T</span>}
          label={t("回到首页")}
          sound="home"
          onClick={() => onNavigate('home')}
        >
          <Logo compact />
        </FocusButton>

        <div className="side-navigation__profile" aria-label={t("当前用户 {0}", { 0: userName })}>
          <span className="side-navigation__avatar"><UserRound size={19} /></span>
          <span className="side-navigation__profile-copy"><small>{t("已登录")}</small><strong>{userName || t("Jellyfin 用户")}</strong></span>
        </div>

        <nav className="main-nav" aria-label={t("主导航")}>
          <FocusButton className="side-navigation__item" variant="ghost" icon={<Home size={22} />} sound="home" active={active === 'home'} onClick={() => onNavigate('home')}>{t("首页")}</FocusButton>
          <FocusButton className="side-navigation__item" variant="ghost" icon={<Search size={22} />} active={active === 'search'} onClick={() => onNavigate('search')}>{t("搜索")}</FocusButton>
          <FocusButton className="side-navigation__item" variant="ghost" icon={<Grid3X3 size={22} />} active={active === 'browse'} onClick={() => onNavigate('browse')}>{t("媒体库")}</FocusButton>
          <FocusButton className="side-navigation__item" variant="ghost" icon={<Heart size={22} />} active={active === 'favorites'} onClick={() => onNavigate('favorites')}>{t("我的收藏")}</FocusButton>
          <FocusButton className="side-navigation__item settings-launch" variant="ghost" icon={<Settings2 size={22} />} sound="open" active={active === 'settings'} onClick={() => onNavigate('settings')}>{t("设置")}</FocusButton>
        </nav>

        <div className="header-spacer" />
        <div className="side-navigation__server" aria-label={t("当前 Jellyfin 服务器 {0}", { 0: serverName })}>
          <span className="server-pill__pulse" />
          <span><small>JELLYFIN SERVER</small><strong>{serverName || 'Jellyfin'}</strong></span>
        </div>
        <nav className="side-navigation__utilities" aria-label={t("服务器操作")}>
          <FocusButton sound="open" className="side-navigation__item tutorial-launch" variant="ghost" icon={<BookOpen size={21} />} onClick={() => onNavigate('tutorial')}>{t("遥控教学")}</FocusButton>
          <FocusButton className="side-navigation__item" variant="ghost" sound="loading" disabled={refreshing} busy={refreshing} icon={<RefreshCw className={cx(refreshing && 'is-spinning')} size={21} />} onClick={onRefresh}>{refreshing ? t("正在刷新") : t("刷新媒体库")}</FocusButton>
          <FocusButton className="side-navigation__item" variant="ghost" icon={<LogOut size={21} />} onClick={onExit}>{t("管理登录")}</FocusButton>
        </nav>
      </div>
    </aside>
  )
}

function MetaRow({ item }: { item: MediaItem }) {
  const facts = [item.year, t(item.kind), item.duration].filter(Boolean)
  return (
    <div className="meta-row">
      {facts.map((fact, index) => <span className="meta-row__fact" key={fact}>{fact}{index < facts.length - 1 && <i />}</span>)}
      {item.rating && <span className="rating"><Star size={16} fill="currentColor" /> {item.rating}</span>}
      {item.resolution && <span className="meta-badge">{item.resolution}</span>}
    </div>
  )
}

const MediaCard = memo(function MediaCard({
  item,
  wide = false,
  library = false,
  onOpen,
  onPreview,
  autoFocusTarget = false,
}: {
  item: MediaItem
  wide?: boolean
  library?: boolean
  onOpen: (item: MediaItem) => void
  onPreview: (item: MediaItem) => void
  autoFocusTarget?: boolean
}) {
  return (
    <button
      type="button"
      data-focusable="true"
      data-autofocus={autoFocusTarget ? 'true' : undefined}
      data-ui-sound="open"
      className={cx('media-card', wide && 'media-card--wide', library && 'media-card--library')}
      onClick={() => onOpen(item)}
      onFocus={() => onPreview(item)}
    >
      <span className="media-card__glow" />
      <ArtFrame item={item} wide={wide || library}><MediaIndicators item={item} /></ArtFrame>
      <span className="media-card__badges">
        {item.folder && <span><Folder size={14} /> {item.sourceType === 'BoxSet' ? t('合集') : item.collectionType === 'boxsets' ? t("合集组") : t('文件夹')}</span>}
        {!item.folder && <span>{t(item.kind)}</span>}
        {item.unwatched && <span className="count-badge">{item.unwatched}  {t("未看")}</span>}
      </span>
      <span className="media-card__copy">
        <strong title={item.title}>{item.title}</strong>
        <small>{item.subtitle}</small>
      </span>
      <span className="media-card__enter"><ChevronRight size={18} /></span>
    </button>
  )
})

type HeroTitleDensity = 'regular' | 'medium' | 'compact' | 'dense'

function heroTitleDensity(title: string): HeroTitleDensity {
  const visualLength = Array.from(title.trim()).reduce((length, character) => {
    if (/\s/.test(character)) return length + 0.35
    if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(character)) return length + 1.8
    return length + 1
  }, 0)

  if (visualLength > 28) return 'dense'
  if (visualLength > 18) return 'compact'
  if (visualLength > 10) return 'medium'
  return 'regular'
}

function HomePage({
  featured,
  shelves,
  focusRegion,
  serverName,
  userName,
  refreshing,
  onNavigate,
  onOpen,
  onPreview,
  onFocusRegionChange,
  onRefresh,
  onExit,
}: {
  featured: MediaItem
  shelves: MediaShelf[]
  focusRegion: HomeFocusRegion
  serverName: string
  userName: string
  refreshing: boolean
  onNavigate: (page: Page) => void
  onOpen: (item: MediaItem) => void
  onPreview: (item: MediaItem) => void
  onFocusRegionChange: (region: HomeFocusRegion) => void
  onRefresh: () => void
  onExit: () => void
}) {
  const titleDensity = heroTitleDensity(featured.title)

  return (
    <div
      className={cx('home-page', 'page-enter', focusRegion === 'shelves' && 'home-page--shelves-active')}
      onFocusCapture={(event) => {
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest('.hero-section')) onFocusRegionChange('hero')
        else if (target?.closest('.shelves')) onFocusRegionChange('shelves')
      }}
    >
      <PageHeader active="home" serverName={serverName} userName={userName} refreshing={refreshing} onNavigate={onNavigate} onRefresh={onRefresh} onExit={onExit} />
      <section className="hero-section">
        <div className="hero-section__copy">
          <div className="hero-eyebrow"><Sparkles size={17} />  {t("tachi 为你推荐")}</div>
          <p className="hero-original">{featured.original}</p>
          <h1 className={cx('hero-title', `hero-title--${titleDensity}`)}>{featured.title}</h1>
          {featured.tagline && <p className="hero-tagline">「{featured.tagline}」</p>}
          <MetaRow item={featured} />
          <p className="hero-overview">{featured.overview || featured.subtitle}</p>
          {featured.progress !== undefined && featured.progress > 0 && (
            <div className="hero-progress">
              <div><span>{t("继续观看")}</span><strong>{featured.subtitle}</strong></div>
              <span>{featured.progress}%</span>
              <i><b style={{ width: `${featured.progress}%` }} /></i>
            </div>
          )}
          <div className="hero-actions">
            <FocusButton variant="primary" autoFocusTarget icon={featured.folder ? <Grid3X3 size={22} /> : <Play size={22} fill="currentColor" />} onClick={() => onOpen(featured)} onFocus={() => onPreview(featured)}>{featured.folder ? t("浏览媒体库") : featured.progress ? t("继续观看") : t("立即观看")}</FocusButton>
            <FocusButton variant="glass" icon={<Info size={21} />} onClick={() => onOpen(featured)} onFocus={() => onPreview(featured)}>{t("查看详情")}</FocusButton>
          </div>
        </div>
        <div className="hero-section__scroll-cue"><span />  {t("向下探索")}</div>
      </section>

      <div className="shelves">
        {shelves.map((shelf, shelfIndex) => (
          <section className="shelf" key={shelf.id}>
            <header className="shelf__header">
              <div><small>{shelf.eyebrow}</small><h2>{t(shelf.title)}<span className="section-count" aria-label={t("{0} 项", { 0: shelf.items.length })}>{shelf.items.length}</span></h2></div>
              <FocusButton variant="ghost" trailing={<ChevronRight size={18} />} onClick={() => onNavigate('browse')}>{t("查看全部")}</FocusButton>
            </header>
            <div className="shelf__rail">
              {shelf.items.map((item, cardIndex) => (
                <MediaCard
                  key={`${shelf.id}-${item.id}`}
                  item={item}
                  library={Boolean(shelf.library)}
                  onOpen={onOpen}
                  onPreview={onPreview}
                  autoFocusTarget={shelfIndex === 0 && cardIndex === 0}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <RemoteHint />
    </div>
  )
}

type BrowseMode = 'library' | 'favorites'
type BrowsePath = Array<{ item: MediaItem; children: MediaItem[] }>

function BrowsePage({
  mode,
  items,
  favorites,
  initialFolder,
  initialPath,
  onRememberPath,
  serverName,
  userName,
  refreshing,
  onLoadFolder,
  onNavigate,
  onOpen,
  onPreview,
  onRefresh,
  onExit,
  onResetLibrary,
}: {
  mode: BrowseMode
  items: MediaItem[]
  favorites: MediaItem[]
  initialFolder?: MediaItem | null
  initialPath?: BrowsePath
  onRememberPath: (path: BrowsePath) => void
  serverName: string
  userName: string
  refreshing: boolean
  onLoadFolder: (parent: MediaItem) => Promise<MediaItem[]>
  onNavigate: (page: Page) => void
  onOpen: (item: MediaItem) => void
  onPreview: (item: MediaItem) => void
  onRefresh: () => void
  onExit: () => void
  onResetLibrary: () => void
}) {
  const [path, setPath] = useState<BrowsePath>(() => initialPath?.length ? initialPath : (
    mode === 'library' && initialFolder ? [{ item: initialFolder, children: [] }] : []
  ))
  const [filter, setFilter] = useState<'all' | 'unwatched' | 'continue' | 'favorite'>('all')
  const [sort, setSort] = useState<'最近加入' | '名称' | '评分最高'>('最近加入')
  const [visibleCount, setVisibleCount] = useState(BROWSE_BATCH_SIZE)
  const [folderLoading, setFolderLoading] = useState(mode === 'library' && Boolean(initialFolder) && !initialPath?.length)
  const [folderError, setFolderError] = useState<{ item: MediaItem; replace: boolean } | null>(null)
  const folderGeneration = useRef(0)
  const browseRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLElement | null>(null)

  const loadFolder = useCallback(async (item: MediaItem, replace = false) => {
    const generation = ++folderGeneration.current
    setFolderLoading(true)
    setFolderError(null)
    try {
      const children = await onLoadFolder(item)
      if (generation !== folderGeneration.current) return
      setPath((current) => replace ? [{ item, children }] : [...current, { item, children }])
      setVisibleCount(BROWSE_BATCH_SIZE)
    } catch {
      if (generation === folderGeneration.current) setFolderError({ item, replace })
    } finally {
      if (generation === folderGeneration.current) setFolderLoading(false)
    }
  }, [onLoadFolder])

  useEffect(() => {
    if (mode === 'library' && initialPath?.length) {
      return () => { folderGeneration.current += 1 }
    }
    if (mode !== 'library' || !initialFolder) {
      setPath([])
      setFolderLoading(false)
      setFolderError(null)
    } else {
      setPath([{ item: initialFolder, children: [] }])
      void loadFolder(initialFolder, true)
    }
    return () => {
      folderGeneration.current += 1
    }
  }, [initialFolder, initialPath, loadFolder, mode])

  const baseItems = useMemo(() => {
    if (mode === 'favorites') return favorites
    return path.length ? path[path.length - 1].children : items
  }, [favorites, items, mode, path])

  const shownItems = useMemo(() => {
    let result = [...baseItems]
    if (filter === 'unwatched') result = result.filter((item) => !item.watched)
    if (filter === 'continue') result = result.filter((item) => item.progress && item.progress > 0 && item.progress < 100)
    if (filter === 'favorite') result = result.filter((item) => item.favorite)
    if (sort === '名称') result.sort((a, b) => a.title.localeCompare(b.title, getLocale()))
    if (sort === '评分最高') result.sort((a, b) => Number(b.rating ?? 0) - Number(a.rating ?? 0))
    return result
  }, [baseItems, filter, sort, getLocale()])

  const visibleItems = shownItems.slice(0, visibleCount)
  const hasMore = visibleItems.length < shownItems.length
  const showsLibraries = mode === 'library' && path.length === 0
  const usesWideCard = (item: MediaItem) => mode === 'library'
    && (showsLibraries || (item.sourceType !== 'Movie' && item.sourceType !== 'Series'))
  const showsWideGrid = mode === 'library' && baseItems.every(usesWideCard)
  const title = mode === 'favorites' ? t("我的收藏") : path.at(-1)?.item.title ?? t("媒体库")
  const eyebrow = mode === 'favorites' ? 'SAVED MOMENTS' : path.length ? 'FOLDER VIEW' : 'ALL LIBRARIES'

  useEffect(() => {
    // Loading can remove the focused card. Recover only when no control kept focus.
    if (currentSpatialFocus()) return
    const root = browseRef.current
    focusSpatialElement(root?.querySelector<HTMLElement>('.empty-state [data-focusable="true"]')
      ?? root?.querySelector<HTMLElement>('.media-grid [data-focusable="true"]')
      ?? root?.querySelector<HTMLElement>('.browse-toolbar [data-focusable="true"]'))
  }, [folderError, folderLoading, shownItems])

  useEffect(() => {
    setVisibleCount(BROWSE_BATCH_SIZE)
  }, [shownItems])

  useEffect(() => {
    if (!hasMore) return
    if (typeof window.IntersectionObserver !== 'function') {
      setVisibleCount(shownItems.length)
      return
    }

    const target = loadMoreRef.current
    if (!target) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setVisibleCount((count) => Math.min(count + BROWSE_BATCH_SIZE, shownItems.length))
    }, { rootMargin: '480px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, shownItems.length, visibleCount])

  const truncatePath = (length: number) => {
    folderGeneration.current += 1
    setFolderLoading(false)
    setFolderError(null)
    setPath((current) => current.slice(0, length))
    setVisibleCount(BROWSE_BATCH_SIZE)
  }

  const resetLibrary = () => {
    truncatePath(0)
    onResetLibrary()
  }

  const openItem = (item: MediaItem) => {
    if (item.folder && mode === 'library') {
      void loadFolder(item)
      return
    }
    if (mode === 'library') onRememberPath(path)
    onOpen(item)
  }

  return (
    <div ref={browseRef} className="browse-page page-enter">
      <PageHeader
        active={mode === 'favorites' ? 'favorites' : 'browse'}
        serverName={serverName}
        userName={userName}
        refreshing={refreshing}
        onNavigate={onNavigate}
        onRefresh={onRefresh}
        onExit={onExit}
      />
      <main className="browse-content">
        <div className="breadcrumbs">
          <FocusButton variant="round" sound="back" label={t("返回上一级")} className="browse-back" onClick={() => path.length > 1 ? truncatePath(path.length - 1) : path.length ? resetLibrary() : onNavigate('home')}><ArrowLeft size={20} /></FocusButton>
          <FocusButton variant="ghost" onClick={() => { setPath([]); onNavigate('home') }}><Home size={16} />  {t("首页")}</FocusButton>
          {mode === 'library' && <><ChevronRight size={15} /><FocusButton variant="ghost" active={!path.length} onClick={resetLibrary}>{t("媒体库")}</FocusButton></>}
          {path.map((crumb, index) => <span className="breadcrumb-part" key={crumb.item.id}><ChevronRight size={15} /><FocusButton variant="ghost" active={index === path.length - 1} onClick={() => truncatePath(index + 1)}>{crumb.item.title}</FocusButton></span>)}
        </div>

        <header className="browse-title-row">
          <div><small>{eyebrow}</small><h1>{title}</h1><p>{folderLoading ? t("正在读取内容…") : folderError ? t("内容尚未载入") : t("{0} 个项目", { 0: baseItems.length })} · Jellyfin / {serverName}</p></div>
          <div className="layout-indicator"><Grid3X3 size={18} /><span>{showsWideGrid ? t("横向缩略图") : t("海报网格")}</span></div>
        </header>

        <section className="browse-toolbar glass-panel">
          <div className="toolbar-group">
            <ListFilter size={18} /><span>{t("筛选")}</span>
            {([
              ['all', t("全部")],
              ['unwatched', t("未观看")],
              ['continue', t("可继续")],
              ['favorite', t("已收藏")],
            ] as const).map(([value, label], index) => (
              <FocusButton key={value} variant="chip" active={filter === value} autoFocusTarget={index === 0} onClick={() => { setFilter(value); setVisibleCount(BROWSE_BATCH_SIZE) }}>{label}</FocusButton>
            ))}
          </div>
          <span className="toolbar-divider" />
          <div className="toolbar-group toolbar-group--sort">
            <ArrowDownUp size={18} /><span>{t("排序")}</span>
            {(['最近加入', '名称', '评分最高'] as const).map((value) => (
              <FocusButton key={value} variant="chip" active={sort === value} onClick={() => setSort(value)}>{t(value)}</FocusButton>
            ))}
          </div>
        </section>

        {folderLoading ? (
          <LoadingCards label={t("正在读取媒体库…")} />
        ) : folderError ? (
          <section className="empty-state glass-panel is-error" role="alert">
            <div className="empty-state__orb"><Info size={32} /></div>
            <small>CONNECTION INTERRUPTED</small>
            <h2>{t("这个目录暂时无法加载")}</h2>
            <p>{t("请检查服务器连接，然后重新尝试。")}</p>
            <FocusButton variant="primary" autoFocusTarget icon={<RefreshCw size={19} />} onClick={() => { void loadFolder(folderError.item, folderError.replace) }}>{t("重新加载")}</FocusButton>
          </section>
        ) : shownItems.length ? (
          <section className={cx(
            'media-grid',
            showsWideGrid && 'media-grid--wide',
          )}>
            {visibleItems.map((item, index) => (
              <MediaCard
                key={item.id}
                item={item}
                wide={usesWideCard(item)}
                library={showsLibraries}
                onOpen={openItem}
                onPreview={onPreview}
                autoFocusTarget={index === 0 && filter !== 'all'}
              />
            ))}
          </section>
        ) : (
          <section className="empty-state glass-panel" role="status">
            <div className="empty-state__orb">{mode === 'favorites' && filter === 'all' ? <Heart size={32} /> : <Search size={32} />}</div>
            <small>{filter !== 'all' ? 'NO MATCHES' : mode === 'favorites' ? 'YOUR COLLECTION' : 'EMPTY LIBRARY'}</small>
            <h2>{filter !== 'all' ? t("没有符合条件的内容") : mode === 'favorites' ? t("还没有收藏内容") : t("这里还没有媒体内容")}</h2>
            <p>{filter !== 'all' ? t("试试其他筛选条件，或查看全部项目。") : mode === 'favorites' ? t("在详情页点亮爱心，喜欢的作品就会出现在这里。") : t("在 Jellyfin 中添加内容后，刷新媒体库即可查看。")}</p>
            {filter !== 'all'
              ? <FocusButton variant="primary" autoFocusTarget icon={<X size={19} />} onClick={() => setFilter('all')}>{t("清除条件")}</FocusButton>
              : <FocusButton variant="primary" autoFocusTarget icon={<Grid3X3 size={19} />} disabled={refreshing} onClick={() => mode === 'favorites' ? onNavigate('browse') : path.length ? resetLibrary() : onRefresh()}>{mode === 'favorites' || path.length ? t("浏览媒体库") : refreshing ? t("正在刷新") : t("刷新媒体库")}</FocusButton>}
          </section>
        )}

        {!folderLoading && !folderError && shownItems.length > 0 && (
          <footer ref={loadMoreRef} className="infinite-scroll-status" aria-live="polite">
            <span>{t("已显示")} {visibleItems.length}  {t("项 / 共")} {shownItems.length}  {t("项")}</span>
            <span className={cx('infinite-scroll-status__state', hasMore && 'is-loading')}>
              {hasMore && <LoaderCircle size={15} />}
              {hasMore ? t("继续向下浏览，自动载入更多") : t("已加载全部内容")}
            </span>
          </footer>
        )}
      </main>
      <RemoteHint />
    </div>
  )
}

type SearchPane = 'keyboard' | 'results'
type SearchKeyboardMode = 'letters' | 'numbers'
type PhoneKeyboardState = 'opening' | 'visible' | 'hidden'
type SearchEpisodeHint = {
  seriesId: string
  season?: number
  episode?: number
}

const searchLetterKeys = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const searchNumberKeys = [...'1234567890']

function SearchPage({
  series,
  indexStatus,
  prioritySeriesIds,
  query,
  focusPane,
  keyboardMode,
  keyboardFocusId,
  resultFocusId,
  phoneKeyboardState,
  serverName,
  userName,
  refreshing,
  onQueryChange,
  onKeyboardModeChange,
  onKeyboardFocus,
  onResultFocus,
  onNavigate,
  onOpen,
  onPreview,
  onRefresh,
  onExit,
}: {
  series: MediaItem[]
  indexStatus: SeriesIndexStatus
  prioritySeriesIds: string[]
  query: string
  focusPane: SearchPane
  keyboardMode: SearchKeyboardMode
  keyboardFocusId: string
  resultFocusId: string
  phoneKeyboardState: PhoneKeyboardState
  serverName: string
  userName: string
  refreshing: boolean
  onQueryChange: (value: string) => void
  onKeyboardModeChange: (mode: SearchKeyboardMode) => void
  onKeyboardFocus: (id: string) => void
  onResultFocus: (id: string) => void
  onNavigate: (page: Page) => void
  onOpen: (item: MediaItem, hint: Omit<SearchEpisodeHint, 'seriesId'>) => void
  onPreview: (item: MediaItem) => void
  onRefresh: () => void
  onExit: () => void
}) {
  const [entries, setEntries] = useState<SeriesIndexEntry[]>([])
  const [buildingLocalIndex, setBuildingLocalIndex] = useState(Boolean(series.length))
  const parsedQuery = useMemo(() => parseSeriesQuery(query), [query])
  const results = useMemo(
    () => searchSeries(entries, query, 24, prioritySeriesIds),
    [entries, prioritySeriesIds, query],
  )
  const keyboardKeys = keyboardMode === 'letters' ? searchLetterKeys : searchNumberKeys
  const availableKeyboardIds = new Set([
    ...keyboardKeys.map((key) => `${keyboardMode}-${key}`),
    'action-mode',
    'action-space',
    'action-clear',
    'action-backspace',
  ])
  const effectiveKeyboardFocusId = availableKeyboardIds.has(keyboardFocusId)
    ? keyboardFocusId
    : keyboardMode === 'letters' ? 'letters-A' : 'numbers-1'
  const effectiveResultId = results.some((result) => result.item.id === resultFocusId)
    ? resultFocusId
    : results[0]?.item.id ?? ''
  const preview = results.find((result) => result.item.id === effectiveResultId) ?? results[0]

  useEffect(() => {
    const controller = new AbortController()
    if (!series.length) {
      setEntries([])
      setBuildingLocalIndex(false)
      return
    }
    setBuildingLocalIndex(true)
    void buildSeriesIndex(series, controller.signal).then((next) => {
      if (!controller.signal.aborted) setEntries(next)
    }).catch(() => {
      if (!controller.signal.aborted) setEntries([])
    }).finally(() => {
      if (!controller.signal.aborted) setBuildingLocalIndex(false)
    })
    return () => controller.abort()
  }, [series])

  useEffect(() => {
    if (preview) onPreview(preview.item)
  }, [onPreview, preview])

  const updateQuery = (value: string) => onQueryChange(value.slice(0, 48))
  const append = (value: string) => updateQuery(`${query}${value.toLocaleLowerCase()}`)
  const appendSpace = () => {
    if (query && !query.endsWith(' ')) updateQuery(`${query} `)
  }
  const indexLoading = indexStatus === 'loading' || buildingLocalIndex
  const statusCopy = indexLoading
    ? t("正在同步完整剧集索引 · 已可搜索 {0} 部", { 0: entries.length })
    : indexStatus === 'error'
      ? t("完整索引暂不可用 · 当前可搜索 {0} 部", { 0: entries.length })
      : t("已索引 {0} 部剧集", { 0: entries.length })
  const phoneKeyboardCopy = phoneKeyboardState === 'visible'
    ? t("手机键盘已就绪 · 输入实时同步")
    : phoneKeyboardState === 'hidden'
      ? t("手机键盘已收起 · 点手机搜索框继续")
      : t("正在唤起手机键盘…")

  return (
    <div
      className="series-search-page page-enter"
      data-keyboard-return-id={effectiveKeyboardFocusId}
    >
      <PageHeader active="search" serverName={serverName} userName={userName} refreshing={refreshing} onNavigate={onNavigate} onRefresh={onRefresh} onExit={onExit} />
      <main className="series-search-content">
        <header className="series-search-heading">
          <div>
            <small>SEARCH SERIES</small>
            <h1>{t("搜索剧集")}</h1>
          </div>
          <p><span /> {statusCopy}</p>
        </header>

        <div className="series-search-workspace">
          <section className="compact-search-keyboard" aria-label={t("Apple TV 风格单行搜索键盘")}>
            <div className="compact-search-query glass-panel" aria-live="polite">
              <Search size={24} />
              <span>
                <strong className={cx(!query && 'is-placeholder')}>
                  {query || t("输入拼音首字母、完整拼音或英文")}<i />
                </strong>
                <small>{t("搜索单位：Series")}</small>
              </span>
              {parsedQuery.episodeHint && (
                <em>{parsedQuery.seasonHint ? `S${parsedQuery.seasonHint} · ` : ''}{t("定位 E")}{parsedQuery.episodeHint}</em>
              )}
              <div className={cx('compact-search-phone-state', `is-${phoneKeyboardState}`)}>
                <Keyboard size={16} />
                <span>{phoneKeyboardCopy}</span>
              </div>
            </div>

            <div className="compact-search-strip glass-panel" data-search-keyboard-row="true">
              <button
                type="button"
                data-focusable="true"
                data-search-keyboard="true"
                data-search-focus-id="action-mode"
                data-autofocus={focusPane === 'keyboard' && effectiveKeyboardFocusId === 'action-mode' ? 'true' : undefined}
                className="compact-search-action compact-search-action--mode"
                onClick={() => onKeyboardModeChange(keyboardMode === 'letters' ? 'numbers' : 'letters')}
                onFocus={() => onKeyboardFocus('action-mode')}
              >
                {keyboardMode === 'letters' ? '123' : 'ABC'}
              </button>
              <button
                type="button"
                data-focusable="true"
                data-search-keyboard="true"
                data-search-focus-id="action-space"
                data-autofocus={focusPane === 'keyboard' && effectiveKeyboardFocusId === 'action-space' ? 'true' : undefined}
                className="compact-search-action compact-search-action--wide"
                onClick={appendSpace}
                onFocus={() => onKeyboardFocus('action-space')}
              >
                 {t("空格")} </button>
              {keyboardKeys.map((key) => {
                const focusId = `${keyboardMode}-${key}`
                return (
                  <button
                    type="button"
                    data-focusable="true"
                    data-search-keyboard="true"
                    data-search-focus-id={focusId}
                    data-autofocus={focusPane === 'keyboard' && effectiveKeyboardFocusId === focusId ? 'true' : undefined}
                    className="compact-search-key"
                    key={key}
                    aria-label={t("输入 {0}", { 0: key })}
                    onClick={() => append(key)}
                    onFocus={(event) => {
                      onKeyboardFocus(focusId)
                      event.currentTarget.scrollIntoView({ behavior: motionScrollBehavior(), block: 'nearest', inline: 'center' })
                    }}
                  >
                    {key}
                  </button>
                )
              })}
              <button
                type="button"
                data-focusable="true"
                data-search-keyboard="true"
                data-search-focus-id="action-clear"
                data-autofocus={focusPane === 'keyboard' && effectiveKeyboardFocusId === 'action-clear' ? 'true' : undefined}
                className="compact-search-action compact-search-action--clear"
                onClick={() => updateQuery('')}
                onFocus={() => onKeyboardFocus('action-clear')}
              >
                 {t("清空")} </button>
              <button
                type="button"
                data-focusable="true"
                data-search-keyboard="true"
                data-search-focus-id="action-backspace"
                data-autofocus={focusPane === 'keyboard' && effectiveKeyboardFocusId === 'action-backspace' ? 'true' : undefined}
                className="compact-search-action compact-search-action--backspace"
                aria-label={t("退格")}
                onClick={() => updateQuery(query.slice(0, -1))}
                onFocus={() => onKeyboardFocus('action-backspace')}
              >
                <DeleteIcon size={18} />
              </button>
            </div>
            <footer><span>{t("下滑进入封面结果")}</span><span>{t("上滑返回字母带")}</span></footer>
          </section>

          <section className="series-search-results" aria-label={t("剧集搜索结果")}>
            <header>
              <div><small>{query ? 'REAL-TIME SERIES' : 'RECOMMENDED SERIES'}</small><h2>{query ? t("搜索结果 · {0}", { 0: results.length }) : t("推荐剧集")}</h2></div>
            </header>

            {results.length ? (
              <div className="series-search-results__list">
                {results.map((result) => {
                  const item = result.item
                  const previewed = item.id === effectiveResultId
                  return (
                    <button
                      type="button"
                      data-focusable="true"
                      data-search-result="true"
                      data-previewed={previewed ? 'true' : undefined}
                      data-autofocus={focusPane === 'results' && previewed ? 'true' : undefined}
                      className={cx('series-search-result', previewed && 'is-previewed')}
                      key={item.id}
                      aria-label={[item.title, item.year, t(result.reason)].filter(Boolean).join('，')}
                      onClick={() => onOpen(item, { season: parsedQuery.seasonHint, episode: parsedQuery.episodeHint })}
                      onFocus={() => { onResultFocus(item.id); onPreview(item) }}
                    >
                      <ArtFrame item={item} className="series-search-result__art"><MediaIndicators item={item} /></ArtFrame>
                      <span className="series-search-result__title">{item.title}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className={cx('series-search-empty', indexLoading && 'is-loading')} role="status">
                {indexLoading ? <LoaderCircle className="is-spinning" size={30} /> : <Search size={30} />}
                <strong>{indexLoading ? t("正在建立剧集索引") : t("没有匹配的剧集")}</strong>
                <span>{indexLoading ? t("索引到达后会自动显示在这里") : t("试试标题拼音或拼音首字母")}</span>
              </div>
            )}
          </section>
        </div>
      </main>
      <RemoteHint />
    </div>
  )
}

function DetailPage({
  item,
  detail,
  loading,
  error,
  initialEpisodeNumber,
  serverName,
  userName,
  refreshing,
  onNavigate,
  onPlay,
  onSelectSeason,
  onToggleFavorite,
  onToggleWatched,
  onOpen,
  onPreview,
  onRefresh,
  onExit,
}: {
  item: MediaItem
  detail: DetailSnapshot | null
  loading: boolean
  error: string
  initialEpisodeNumber?: number
  serverName: string
  userName: string
  refreshing: boolean
  onNavigate: (page: Page) => void
  onPlay: (item: MediaItem, fromStart?: boolean) => void
  onSelectSeason: (seasonId: string) => void
  onToggleFavorite: (item: MediaItem, favorite: boolean) => Promise<boolean>
  onToggleWatched: (item: MediaItem, watched: boolean) => Promise<boolean>
  onOpen: (item: MediaItem) => void
  onPreview: (item: MediaItem) => void
  onRefresh: () => void
  onExit: () => void
}) {
  const detailItem = detail?.item ?? item
  const episodes = detail?.episodes ?? []
  const recentEpisode = latestWatchedEpisode(episodes)
  const resolvedItem = detailItem.sourceType === 'Episode' && recentEpisode ? recentEpisode : detailItem
  const similar = detail?.similar ?? []
  const extras = detail?.extras ?? []
  const [favorite, setFavorite] = useState(Boolean(resolvedItem.favorite))
  const [watched, setWatched] = useState(Boolean(resolvedItem.watched))
  const [actionBusy, setActionBusy] = useState<'favorite' | 'watched' | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [infoTab, setInfoTab] = useState<'credits' | 'media'>('credits')
  const [detailSection, setDetailSection] = useState<'episodes' | 'similar' | 'clips' | 'details'>('episodes')
  const detailPageRef = useRef<HTMLDivElement>(null)
  const appliedEpisodeHint = useRef('')

  useEffect(() => {
    setFavorite(Boolean(resolvedItem.favorite))
    setWatched(Boolean(resolvedItem.watched))
  }, [resolvedItem.favorite, resolvedItem.id, resolvedItem.watched])

  useEffect(() => {
    if (!detail || loading || episodes.length || detailSection !== 'episodes') return
    setDetailSection(similar.length ? 'similar' : 'details')
  }, [detail, detailSection, episodes.length, loading, similar.length])

  const hintedEpisode = initialEpisodeNumber
    ? episodes.find((episode) => episode.indexNumber === initialEpisodeNumber)
    : undefined
  const resumeEpisode = recentEpisode && (recentEpisode.playbackPositionTicks ?? 0) > 0 ? recentEpisode : undefined
  const playTarget = hintedEpisode ?? resumeEpisode ?? (resolvedItem.canPlay
    ? resolvedItem
    : episodes.find((episode) => !episode.watched) ?? episodes[0])
  const entryEpisode = hintedEpisode ?? recentEpisode ?? playTarget
  const playProgress = resumeProgress(playTarget)
  const hasResume = (playTarget?.playbackPositionTicks ?? 0) > 0
  const episodeRailRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const rail = episodeRailRef.current
    const target = rail?.querySelector<HTMLElement>('[data-episode-entry="true"]')
    if (loading || !rail || !target) return
    rail.dataset.resumeEntry = 'pending'
    const targetRect = target.getBoundingClientRect()
    const railRect = rail.getBoundingClientRect()
    rail.scrollTo({ left: rail.scrollLeft + targetRect.left + targetRect.width / 2
      - railRect.left - railRect.width / 2, behavior: 'instant' })
  }, [detail?.selectedSeasonId, detailSection, entryEpisode?.id, loading])
  const directors = resolvedItem.people?.filter((person) => person.type === 'Director').map((person) => person.name) ?? []
  const writers = resolvedItem.people?.filter((person) => ['Writer', 'Screenplay'].includes(person.type)).map((person) => person.name) ?? []
  const actors = resolvedItem.people?.filter((person) => person.type === 'Actor').map((person) => person.name) ?? []
  const mediaItem = playTarget ?? resolvedItem
  const dimension = mediaItem.width && mediaItem.height ? `${mediaItem.width}×${mediaItem.height}` : ''
  const bitrate = mediaItem.bitrate ? `${(mediaItem.bitrate / 1_000_000).toFixed(1)} Mbps` : ''
  const premiere = resolvedItem.dateCreated
    ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(resolvedItem.dateCreated))
    : t("未提供")
  const toggleFavorite = async () => {
    if (actionBusy) return
    setActionBusy('favorite')
    try {
      const next = !favorite
      if (await onToggleFavorite(resolvedItem, next)) setFavorite(next)
    } finally {
      setActionBusy(null)
    }
  }

  const toggleWatched = async () => {
    if (actionBusy) return
    setActionBusy('watched')
    try {
      const next = !watched
      if (await onToggleWatched(resolvedItem, next)) setWatched(next)
    } finally {
      setActionBusy(null)
    }
  }

  const restoreSeriesBackdropOutsideEpisodes = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    if (target.closest('.episode-card')) return
    onPreview(resolvedItem)
  }

  useEffect(() => {
    if (!initialEpisodeNumber || loading || !hintedEpisode) return
    const hintKey = `${detail?.selectedSeasonId ?? ''}:${hintedEpisode.id}`
    if (appliedEpisodeHint.current === hintKey) return
    const timer = window.setTimeout(() => {
      const target = Array.from(detailPageRef.current?.querySelectorAll<HTMLElement>('[data-episode-number]') ?? [])
        .find((episode) => Number(episode.dataset.episodeNumber) === initialEpisodeNumber)
      if (!target) return
      appliedEpisodeHint.current = hintKey
      setDetailSection('episodes')
      focusSpatialElement(target)
      target.scrollIntoView({ behavior: motionScrollBehavior(), block: 'center', inline: 'center' })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [detail?.selectedSeasonId, hintedEpisode, initialEpisodeNumber, loading])

  return (
    <div
      ref={detailPageRef}
      className="detail-page page-enter"
      onFocusCapture={(event) => restoreSeriesBackdropOutsideEpisodes(event.target)}
      onPointerDownCapture={(event) => restoreSeriesBackdropOutsideEpisodes(event.target)}
    >
      <PageHeader active="none" minimal serverName={serverName} userName={userName} refreshing={refreshing} onNavigate={onNavigate} onRefresh={onRefresh} onExit={onExit} />
      <main className="detail-content">
        <FocusButton variant="round" className="detail-back" sound="back" label={t("返回")} onClick={() => onNavigate('home')}><ArrowLeft size={22} /></FocusButton>
        <section className="detail-hero">
          <div className="detail-poster-wrap"><ArtFrame item={resolvedItem} className="detail-poster" /></div>
          <div className="detail-copy">
            <div className="detail-title-lockup">
              <div className="detail-kicker">JELLYFIN · {resolvedItem.sourceType?.toLocaleUpperCase() ?? 'MEDIA'}</div>
              <h1>{resolvedItem.title}</h1>
              {resolvedItem.original && <p className="detail-original">{resolvedItem.original}</p>}
              {resolvedItem.tagline && <p className="detail-tagline">{resolvedItem.tagline}</p>}
            </div>
            <div className="detail-format-badges" aria-label={t("媒体格式")}>
              {resolvedItem.officialRating && <span className="detail-format-badges__rating">{resolvedItem.officialRating}</span>}
              {mediaItem.resolution && <span>{mediaItem.resolution}</span>}
              {mediaItem.videoCodec && <span>{mediaItem.videoCodec}</span>}
              {mediaItem.audioCodec && <span>{mediaItem.audioCodec}</span>}
              {mediaItem.container && <span>{mediaItem.container}</span>}
            </div>
            <div className="detail-facts">
              {[
                resolvedItem.year,
                detail?.seasons.length ? t("共 {0} 季", { 0: detail.seasons.length }) : '',
                resolvedItem.duration,
                resolvedItem.genres?.slice(0, 4).join('、'),
              ].filter(Boolean).map((fact, index) => <span key={index}>{fact}</span>)}
              {resolvedItem.rating && <span className="detail-score"><Star size={14} fill="currentColor" /> {resolvedItem.rating}</span>}
            </div>
            <div className={cx('detail-overview', expanded && 'is-expanded')}>
              <p>{resolvedItem.overview || t("Jellyfin 暂未提供这项内容的剧情简介。")}</p>
              {resolvedItem.overview && resolvedItem.overview.length > 120 && <FocusButton variant="ghost" trailing={<ChevronRight size={17} />} onClick={() => setExpanded((value) => !value)}>{expanded ? t("收起剧情") : t("完整剧情")}</FocusButton>}
            </div>
            {playTarget?.sourceType === 'Episode' && (
              <p className="detail-resume-episode">{hasResume ? t("上次看到") : t("即将播放")} · {playTarget.subtitle}</p>
            )}
            <div className="detail-actions">
              <FocusButton variant="primary" className={cx('detail-play-button', hasResume && 'has-progress')} progress={hasResume ? playProgress : undefined} autoFocusTarget={!initialEpisodeNumber} disabled={!playTarget || loading} icon={<Play size={23} fill="currentColor" />} trailing={<span className="key-hint">{t("单击")}</span>} onClick={() => playTarget && onPlay(playTarget)}>
                <span className="detail-play-button__copy"><strong>{playTarget?.sourceType === 'Episode' && playTarget.indexNumber !== undefined ? t("{0}第 {1} 集", { 0: hasResume ? t("继续") : t("播放"), 1: playTarget.indexNumber }) : hasResume ? t("继续播放") : t("立即播放")}</strong>{hasResume && <small>{t("已看到")} {watchedTime(playTarget)}</small>}</span>
              </FocusButton>
              <FocusButton variant="glass" disabled={!playTarget || loading} icon={<RotateCcw size={20} />} onClick={() => playTarget && onPlay(playTarget, true)}>{t("从头播放")}</FocusButton>
              {extras[0] && <FocusButton variant="round" label={t("播放预告片")} onClick={() => onPlay(extras[0], true)}><MonitorPlay size={20} /></FocusButton>}
              <FocusButton variant="round" className="detail-state-action" disabled={Boolean(actionBusy)} busy={actionBusy === 'favorite'} active={favorite} label={actionBusy === 'favorite' ? t("正在更新收藏") : favorite ? t("取消收藏") : t("收藏")} onClick={() => { void toggleFavorite() }}>{actionBusy === 'favorite' ? <LoaderCircle className="is-spinning" size={20} /> : <Heart size={20} fill={favorite ? 'currentColor' : 'none'} />}</FocusButton>
              <FocusButton variant="round" className="detail-state-action" disabled={Boolean(actionBusy)} busy={actionBusy === 'watched'} active={watched} label={actionBusy === 'watched' ? t("正在更新观看状态") : watched ? t("标记为未看") : t("标记已看")} onClick={() => { void toggleWatched() }}>{actionBusy === 'watched' ? <LoaderCircle className="is-spinning" size={21} /> : <Check size={21} />}</FocusButton>
            </div>
            <div className={cx('detail-sync', error && 'is-error')} role="status">
              {loading ? <><LoaderCircle className="is-spinning" size={16} />  {t("正在同步详情…")}</> : error ? <><Info size={16} />{error}</> : null}
            </div>
          </div>
        </section>

        <nav className="detail-tabs" aria-label={t("详情内容分类")}>
          {(episodes.length > 0 || loading) && <FocusButton variant="ghost" active={detailSection === 'episodes'} onClick={() => setDetailSection('episodes')}>{t("剧集")}</FocusButton>}
          {similar.length > 0 && <FocusButton variant="ghost" active={detailSection === 'similar'} onClick={() => setDetailSection('similar')}>{t("相关推荐")}</FocusButton>}
          {extras.length > 0 && <FocusButton variant="ghost" active={detailSection === 'clips'} onClick={() => setDetailSection('clips')}>{t("额外片段")}</FocusButton>}
          <FocusButton variant="ghost" active={detailSection === 'details'} onClick={() => setDetailSection('details')}>{t("详细信息")}</FocusButton>
        </nav>

        <div className="detail-tab-stage">
          {detailSection === 'episodes' && (
            <section className="episode-section detail-tab-panel">
              <header className="section-heading">
                <div><small>EPISODES</small><h2>{t("剧集与章节")}{!loading && <span className="section-count">{episodes.length}</span>}</h2></div>
                <div className="season-switcher">
                  {detail?.seasons.map((season) => <FocusButton key={season.id} variant="chip" disabled={loading} busy={loading} active={detail.selectedSeasonId === season.id} onClick={() => { onPreview(resolvedItem); onSelectSeason(season.id) }}>{season.original || season.title}</FocusButton>)}
                </div>
              </header>
              {loading ? <LoadingCards label={t("正在读取剧集…")} rail /> : <div ref={episodeRailRef} className="episode-rail">
                {episodes.map((episode, index) => {
                  const episodeNumber = episode.indexNumber ?? index + 1
                  const episodeTitle = `${episodeNumber}.${episode.original || episode.title}`
                  return (
                    <button key={episode.id} type="button" data-focusable="true" data-autofocus={initialEpisodeNumber === episode.indexNumber ? 'true' : undefined} data-episode-number={episode.indexNumber} data-episode-entry={entryEpisode?.id === episode.id ? 'true' : undefined} className="episode-card" onClick={() => onPlay(episode)} onFocus={() => onPreview(episode)}>
                      <ArtFrame item={episode} wide>
                        <span className="episode-card__number">{String(episodeNumber).padStart(2, '0')}</span>
                        <span className="episode-card__play"><Play size={19} fill="currentColor" /></span>
                        <MediaIndicators item={episode} />
                        {recentEpisode?.id === episode.id && <span className="episode-card__resume">{t("看到这")}</span>}
                      </ArtFrame>
                      <span className="episode-card__copy"><strong title={episodeTitle}>{episodeTitle}</strong><small>{(episode.playbackPositionTicks ?? 0) > 0 ? t("已看到 {0}", { 0: watchedTime(episode) }) : episode.duration || episode.subtitle}</small></span>
                    </button>
                  )
                })}
              </div>}
            </section>
          )}

          {detailSection === 'similar' && (
            <section className="similar-section detail-tab-panel">
              <header className="section-heading"><div><small>SIMILAR FREQUENCIES</small><h2>{t("更多类似内容")}<span className="section-count">{similar.length}</span></h2></div></header>
              <div className="shelf__rail">
                {similar.map((related) => <MediaCard key={related.id} item={related} wide onOpen={onOpen} onPreview={onPreview} />)}
              </div>
            </section>
          )}

          {detailSection === 'clips' && (
            <section className="similar-section detail-tab-panel">
              <header className="section-heading"><div><small>EXTRAS</small><h2>{t("额外片段")}<span className="section-count">{extras.length}</span></h2></div></header>
              <div className="shelf__rail">
                {extras.map((clip) => <MediaCard key={clip.id} item={clip} wide onOpen={(selectedClip) => onPlay(selectedClip, true)} onPreview={onPreview} />)}
              </div>
            </section>
          )}

          {detailSection === 'details' && (
            <section className="details-section detail-tab-panel">
              <header className="section-heading">
                <div><small>BEHIND THE FRAME</small><h2>{t("详细信息")}</h2></div>
                <div className="season-switcher">
                  <FocusButton variant="chip" active={infoTab === 'credits'} onClick={() => setInfoTab('credits')}>{t("演职与资料")}</FocusButton>
                  <FocusButton variant="chip" active={infoTab === 'media'} onClick={() => setInfoTab('media')}>{t("媒体规格")}</FocusButton>
                </div>
              </header>
              {infoTab === 'credits' ? (
                <div key="credits" className="info-grid glass-panel detail-info-panel">
                  <dl><dt>{t("导演")}</dt><dd>{directors.join('、') || t("未提供")}</dd><dt>{t("编剧")}</dt><dd>{writers.join('、') || t("未提供")}</dd></dl>
                  <dl><dt>{t("主演")}</dt><dd>{actors.slice(0, 8).join('、') || t("未提供")}</dd><dt>{t("工作室")}</dt><dd>{resolvedItem.studios?.join('、') || t("未提供")}</dd></dl>
                  <dl><dt>{t("加入日期")}</dt><dd>{premiere}</dd><dt>{t("分类")}</dt><dd>{t(resolvedItem.kind)}</dd></dl>
                  <dl><dt>{t("标签")}</dt><dd>{resolvedItem.genres?.join('、') || t("未提供")}</dd><dt>{t("路径")}</dt><dd>{resolvedItem.path || t("未提供")}</dd></dl>
                </div>
              ) : (
                <div key="media" className="spec-grid glass-panel detail-info-panel">
                  <div><MonitorPlay size={23} /><span><small>{t("视频")}</small><strong>{[mediaItem.videoCodec, dimension, mediaItem.resolution].filter(Boolean).join(' · ') || t("播放时由 Jellyfin 选择规格")}</strong></span></div>
                  <div><AudioLines size={23} /><span><small>{t("音频")}</small><strong>{mediaItem.audioCodec || t("播放时由 Jellyfin 选择音轨")}</strong></span></div>
                  <div><Subtitles size={23} /><span><small>{t("字幕")}</small><strong>{t("播放时可选择服务器提供的字幕轨")}</strong></span></div>
                  <div><Server size={23} /><span><small>{t("文件")}</small><strong>{[mediaItem.container, bitrate].filter(Boolean).join(' · ') || serverName}</strong></span></div>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
      <RemoteHint />
    </div>
  )
}

function formatTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(hours ? 2 : 1, '0')}:${String(remainder).padStart(2, '0')}`
}

type SubtitleCue = {
  start: number
  end: number
  text: string
}

function subtitleMarkupText(source: string) {
  if (!source) return ''

  const parsed = new DOMParser().parseFromString(
    `<body>${source.replace(/<br\s*\/?>/gi, '\n')}</body>`,
    'text/html',
  )
  return (parsed.body.textContent ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function subtitleTimestamp(value: string) {
  const parts = value.replace(',', '.').split(':')
  const seconds = Number(parts.pop())
  const minutes = Number(parts.pop())
  const hours = Number(parts.pop() ?? 0)
  if (![hours, minutes, seconds].every(Number.isFinite)) return Number.NaN
  return hours * 3600 + minutes * 60 + seconds
}

function parseWebVtt(source: string) {
  const cues: SubtitleCue[] = []
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const timing = /^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:\s|$)/

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(timing)
    if (!match) continue

    const start = subtitleTimestamp(match[1])
    const end = subtitleTimestamp(match[2])
    const text: string[] = []
    index += 1
    while (index < lines.length && lines[index].trim()) {
      text.push(lines[index])
      index += 1
    }

    const content = subtitleMarkupText(text.join('\n'))
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && content) {
      cues.push({ start, end, text: content })
    }
  }

  return cues
}

const jellyfinTicksPerSecond = 10_000_000

type PlayerStatus = 'preparing' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error'
type PlayerChrome = 'controls' | 'hidden' | 'topbar'

function PlayerPage({
  simpleUi,
  subtitleSize,
  item,
  startPositionTicks,
  infoVisible,
  onToggleInfo,
  previousItem,
  nextItem,
  preparePlayback,
  reportPlaybackStarted,
  reportPlaybackProgress,
  reportPlaybackStopped,
  onPlayItem,
  onBack,
}: {
  simpleUi: boolean
  subtitleSize: SubtitleSize
  item: MediaItem
  startPositionTicks: number
  infoVisible: boolean
  onToggleInfo: () => void
  previousItem?: MediaItem
  nextItem?: MediaItem
  preparePlayback: (item: MediaItem, positionTicks: number, selection?: PlaybackSelection) => Promise<PlaybackPlan>
  reportPlaybackStarted: (plan: PlaybackPlan, paused: boolean, positionTicks: number) => Promise<void>
  reportPlaybackProgress: (plan: PlaybackPlan, paused: boolean, positionTicks: number) => Promise<void>
  reportPlaybackStopped: (plan: PlaybackPlan, positionTicks: number, failed?: boolean) => Promise<void>
  onPlayItem: (item: MediaItem, fromStart?: boolean) => void
  onBack: () => void
}) {
  const playerPageRef = useRef<HTMLDivElement>(null)
  const bottomChromeRef = useRef<HTMLDivElement>(null)
  const native = hasNativePlayback()
  const browserVideoRef = useRef<HTMLVideoElement>(null)
  const videoRef = useRef<PlaybackSurface | null>(null)
  useLayoutEffect(() => {
    if (!native) { videoRef.current = browserVideoRef.current; return }
    const player = new NativePlayback(() => playerPageRef.current)
    videoRef.current = player
    document.documentElement.classList.add('native-playback')
    return () => {
      player.dispose()
      document.documentElement.classList.remove('native-playback')
    }
  }, [native])
  const hlsRef = useRef<Hls | null>(null)
  const infoSourceRef = useRef<PlaybackInfoSource>({ plan: null, codecs: {} })
  const planRef = useRef<PlaybackPlan | null>(null)
  const statusRef = useRef<PlayerStatus>('preparing')
  const prepareGeneration = useRef(0)
  const desiredPlaying = useRef(true)
  const seekAppliedKey = useRef('')
  const fallbackUsed = useRef(false)
  const startedPlans = useRef(new Set<string>())
  const stoppedPlans = useRef(new Set<string>())
  const currentRef = useRef(startPositionTicks / jellyfinTicksPerSecond)
  const [plan, setPlan] = useState<PlaybackPlan | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('preparing')
  const [hasVideoFrame, setHasVideoFrame] = useState(false)
  const backdropMounted = usePresence(!hasVideoFrame)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState(startPositionTicks / jellyfinTicksPerSecond)
  const [total, setTotal] = useState((item.runtimeTicks ?? 0) / jellyfinTicksPerSecond)
  const [chrome, setChrome] = useState<PlayerChrome>('controls')
  const chromeRef = useRef<PlayerChrome>('controls')
  const controls = chrome === 'controls'
  useLayoutEffect(() => suspendHiddenAnimations(bottomChromeRef.current, !controls), [controls])
  const [panel, setPanel] = useState<'audio' | 'subtitles' | null>(null)
  const [feedback, setFeedback] = useState<{ direction: 'backward' | 'forward'; seconds: number; id: number } | null>(null)
  const [volume, setVolume] = useState(100)
  const [volumeVisible, setVolumeVisible] = useState(false)
  const volumeMounted = usePresence(volumeVisible)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([])
  const [subtitleLoadError, setSubtitleLoadError] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const feedbackTimer = useRef<number | null>(null)
  const volumeTimer = useRef<number | null>(null)
  const trackPanelRef = useRef<HTMLElement>(null)
  const trackPanelReturnFocus = useRef<HTMLElement | null>(null)
  const trackPanelFocusFrame = useRef<number | null>(null)
  const trackPanelRestoreFrame = useRef<number | null>(null)
  const feedbackId = useRef(0)
  const playing = status === 'playing' || status === 'buffering'

  const updateChrome = useCallback((next: PlayerChrome) => {
    chromeRef.current = next
    setChrome(next)
  }, [])

  const updateStatus = useCallback((nextStatus: PlayerStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  useEffect(() => {
    currentRef.current = current
  }, [current])

  useEffect(() => {
    const url = plan?.subtitleUrl
    setSubtitleCues([])
    setSubtitleLoadError(false)
    if (!url || (plan?.subtitleStreamIndex ?? -1) < 0 || plan?.subtitleFormat === 'ass') return

    const controller = new AbortController()
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.text()
      })
      .then((source) => {
        if (controller.signal.aborted) return
        const cues = parseWebVtt(source)
        if (!cues.length) throw new Error(t("WebVTT 没有可显示的字幕内容"))
        setSubtitleCues(cues)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return
        setSubtitleLoadError(true)
      })

    return () => controller.abort()
  }, [plan?.playSessionId, plan?.subtitleStreamIndex, plan?.subtitleUrl, plan?.subtitleFormat])

  useEffect(() => {
    if (videoRef.current instanceof NativePlayback) videoRef.current.setSubtitleError(subtitleLoadError)
  }, [subtitleLoadError, plan])

  const planKey = useCallback((value: PlaybackPlan) => (
    `${value.itemId}:${value.playSessionId}:${value.playMethod}`
  ), [])

  const positionTicks = useCallback(() => {
    const video = videoRef.current
    const seconds = video && Number.isFinite(video.currentTime) ? video.currentTime : currentRef.current
    return Math.max(0, Math.round(seconds * jellyfinTicksPerSecond))
  }, [])

  const circularSeekEnabled = useCallback(() => (
    chromeRef.current === 'controls'
    && !document.hidden
    && !['preparing', 'error', 'stopped'].includes(statusRef.current)
    && Boolean(planRef.current?.canSeek)
    && (!(videoRef.current instanceof NativePlayback) || videoRef.current.canSeek)
    && Number.isFinite(videoRef.current?.duration) && Number(videoRef.current?.duration) > 0
    && !playerPageRef.current?.querySelector('.track-panel')
    && Boolean(currentSpatialFocus()?.matches('.player-progress__bar'))
  ), [])

  const publishNativePlaybackState = useCallback((nextStatus: PlayerStatus | 'stopped') => {
    const active = planRef.current
    const videoDuration = videoRef.current?.duration
    const durationTicks = Number.isFinite(videoDuration) && Number(videoDuration) > 0
      ? Math.round(Number(videoDuration) * jellyfinTicksPerSecond)
      : Math.max(0, active?.durationTicks ?? item.runtimeTicks ?? 0)
    postNativeMessage({
      type: 'playback_state',
      state: nextStatus,
      itemId: item.id,
      title: item.title,
      subtitle: item.original && item.original !== item.title ? item.original : item.subtitle,
      playMethod: active?.playMethod ?? '',
      positionTicks: positionTicks(),
      durationTicks,
      seekEnabled: nextStatus !== 'stopped' && circularSeekEnabled(),
    })
  }, [circularSeekEnabled, item.id, item.original, item.runtimeTicks, item.subtitle, item.title, positionTicks])

  useEffect(() => {
    const publish = () => publishNativePlaybackState(statusRef.current)
    publish()
    document.addEventListener('focusin', publish)
    document.addEventListener('focusout', publish)
    document.addEventListener('visibilitychange', publish)
    return () => {
      document.removeEventListener('focusin', publish)
      document.removeEventListener('focusout', publish)
      document.removeEventListener('visibilitychange', publish)
    }
  }, [chrome, panel, plan, publishNativePlaybackState, status, total])

  useEffect(() => () => {
    publishNativePlaybackState('stopped')
  }, [publishNativePlaybackState])

  const stopPlan = useCallback((value: PlaybackPlan | null, failed = false) => {
    if (!value) return
    const key = planKey(value)
    if (stoppedPlans.current.has(key)) return
    stoppedPlans.current.add(key)
    void reportPlaybackStopped(value, positionTicks(), failed).catch(() => undefined)
  }, [planKey, positionTicks, reportPlaybackStopped])

  const prepare = useCallback(async (
    requestedPositionTicks: number,
    selection: PlaybackSelection = {},
    shouldPlay = true,
  ) => {
    const generation = ++prepareGeneration.current
    desiredPlaying.current = shouldPlay
    fallbackUsed.current = false
    seekAppliedKey.current = ''
    updateStatus('preparing')
    setHasVideoFrame(false)
    hlsRef.current?.destroy()
    hlsRef.current = null
    infoSourceRef.current = { plan: null, codecs: {} }
    videoRef.current?.pause()
    setPanel(null)
    setError('')
    currentRef.current = requestedPositionTicks / jellyfinTicksPerSecond
    setCurrent(requestedPositionTicks / jellyfinTicksPerSecond)

    try {
      const next = await preparePlayback(item, requestedPositionTicks, selection)
      if (generation !== prepareGeneration.current) return
      planRef.current = next
      setPlan(next)
      setTotal((next.durationTicks || item.runtimeTicks || 0) / jellyfinTicksPerSecond)
      updateStatus('buffering')
    } catch (reason) {
      if (generation !== prepareGeneration.current) return
      planRef.current = null
      setPlan(null)
      setError(reason instanceof Error ? reason.message : t("无法准备 Jellyfin 播放。"))
      updateStatus('error')
      updateChrome('controls')
    }
  }, [item, preparePlayback, updateChrome, updateStatus])

  useEffect(() => {
    startedPlans.current.clear()
    stoppedPlans.current.clear()
    planRef.current = null
    setPlan(null)
    void prepare(startPositionTicks)
    return () => {
      prepareGeneration.current += 1
    }
  }, [prepare, startPositionTicks])

  const failPlayback = useCallback((message: string) => {
    const active = planRef.current
    if (active?.fallback && !fallbackUsed.current) {
      fallbackUsed.current = true
      stopPlan(active, true)
      const fallback: PlaybackPlan = {
        ...active,
        ...active.fallback,
        startPositionTicks: positionTicks(),
        fallback: undefined,
      }
      seekAppliedKey.current = ''
      planRef.current = fallback
      setPlan(fallback)
      updateStatus('buffering')
      setError('')
      updateChrome('controls')
      return
    }

    stopPlan(active, true)
    setError(message || t("媒体流无法播放，请返回后重试。"))
    updateStatus('error')
    updateChrome('controls')
  }, [positionTicks, stopPlan, updateChrome, updateStatus])

  useEffect(() => {
    if (!plan) return
    if (videoRef.current instanceof NativePlayback) {
      const player = videoRef.current
      setHasVideoFrame(false)
      infoSourceRef.current = { plan, codecs: {} }
      player.open(plan, desiredPlaying.current)
      return () => player.stop()
    }
    const video = browserVideoRef.current
    if (!video) return

    setHasVideoFrame(false)
    video.pause()
    video.removeAttribute('src')
    video.load()
    hlsRef.current?.destroy()
    hlsRef.current = null
    infoSourceRef.current = { plan, codecs: {} }
    seekAppliedKey.current = ''
    const hlsMedia = plan.transcoding || /\.m3u8(?:$|\?)/i.test(plan.url)

    let disposed = false
    const generation = prepareGeneration.current
    const isCurrentSource = () => !disposed && generation === prepareGeneration.current
    const loadSource = async () => {
      if (hlsMedia) {
        const { default: Hls } = await import('hls.js')
        if (!isCurrentSource()) return
        if (Hls.isSupported()) {
          let mediaRecoveryAttempted = false
          const hls = new Hls({
            enableWorker: true,
            backBufferLength: 90,
            maxBufferLength: 45,
            maxMaxBufferLength: 90,
          })
          hlsRef.current = hls
          hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            if (isCurrentSource()) hls.loadSource(plan.url)
          })
          hls.on(Hls.Events.BUFFER_CODECS, (_event, tracks) => {
            if (!isCurrentSource()) return
            // Demuxed codecs remain available when a media playlist omits CODECS.
            infoSourceRef.current.codecs = {
              ...infoSourceRef.current.codecs,
              ...(tracks.video?.codec ? { videoCodec: tracks.video.codec } : {}),
              ...(tracks.audio?.codec ? { audioCodec: tracks.audio.codec } : {}),
            }
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!isCurrentSource() || !data.fatal) return
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
              mediaRecoveryAttempted = true
              try {
                hls.recoverMediaError()
                return
              } catch {
                // Fall through to the user-visible playback failure.
              }
            }
            failPlayback(t("Jellyfin HLS 媒体流已中断。"))
          })
          hls.attachMedia(video)
          return
        }
      }
      video.src = plan.url
      video.load()
    }
    void loadSource().catch(() => {
      if (isCurrentSource()) failPlayback(t("Jellyfin 媒体流无法加载。"))
    })

    return () => {
      disposed = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [failPlayback, plan])

  const applyInitialSeek = useCallback(() => {
    const video = videoRef.current
    const active = planRef.current
    if (!video || !active || video instanceof NativePlayback) return
    const key = planKey(active)
    if (seekAppliedKey.current === key) return
    seekAppliedKey.current = key
    const startSeconds = active.startPositionTicks / jellyfinTicksPerSecond
    if (startSeconds > 0 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(startSeconds, Math.max(0, video.duration - .15))
    }
    if (Number.isFinite(video.duration) && video.duration > 0) setTotal(video.duration)
    currentRef.current = video.currentTime || startSeconds
    setCurrent(video.currentTime || startSeconds)
  }, [planKey])

  const attemptPlay = useCallback(() => {
    const video = videoRef.current
    if (!video || statusRef.current === 'preparing' || statusRef.current === 'error') return
    applyInitialSeek()
    // A paused track change still finishes loading without starting playback.
    if (!desiredPlaying.current) {
      updateStatus('paused')
      return
    }
    void video.play().catch(() => {
      desiredPlaying.current = false
      updateStatus('paused')
      updateChrome('controls')
    })
  }, [applyInitialSeek, updateChrome, updateStatus])

  const togglePlayback = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (status === 'error') {
      void prepare(positionTicks(), {
        mediaSourceId: planRef.current?.mediaSourceId,
        audioStreamIndex: planRef.current?.audioStreamIndex,
        subtitleStreamIndex: planRef.current?.subtitleStreamIndex,
      })
      return
    }
    if (video.ended) {
      void prepare(0, { mediaSourceId: planRef.current?.mediaSourceId,
        audioStreamIndex: planRef.current?.audioStreamIndex, subtitleStreamIndex: planRef.current?.subtitleStreamIndex })
      return
    }
    if (video.paused) {
      desiredPlaying.current = true
      void video.play().catch(() => updateStatus('paused'))
    } else {
      desiredPlaying.current = false
      video.pause()
    }
  }, [positionTicks, prepare, status, updateStatus])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    if (status === 'playing' && !panel) {
      hideTimer.current = window.setTimeout(() => {
        updateChrome('hidden')
      }, 3200)
    }
  }, [panel, status, updateChrome])

  const reveal = useCallback(() => {
    updateChrome('controls')
    scheduleHide()
  }, [scheduleHide, updateChrome])

  const seek = useCallback((seconds: number, showControls = true) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || !planRef.current?.canSeek) return
    const next = Math.max(0, Math.min(video.duration, video.currentTime + seconds))
    const applied = next - video.currentTime
    video.currentTime = next
    currentRef.current = next
    setCurrent(next)
    setFeedback({ direction: seconds > 0 ? 'forward' : 'backward', seconds: Math.round(Math.abs(applied)), id: ++feedbackId.current })
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 920)
    if (showControls) reveal()
  }, [reveal])

  const focusTrackPanelTarget = useCallback((target?: HTMLElement | null) => {
    if (!target) return false
    focusSpatialElement(target)

    const list = target.closest<HTMLElement>('.track-list')
    if (!list) return true

    const targetRect = target.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    const focusInset = 10
    const scrollDelta = targetRect.top < listRect.top + focusInset
      ? targetRect.top - listRect.top - focusInset
      : targetRect.bottom > listRect.bottom - focusInset
        ? targetRect.bottom - listRect.bottom + focusInset
        : 0

    if (scrollDelta) {
      list.scrollTo({
        top: list.scrollTop + scrollDelta,
        behavior: motionScrollBehavior(),
      })
    }
    return true
  }, [])

  const closeTrackPanel = useCallback((restoreFocus = true) => {
    const returnTarget = trackPanelReturnFocus.current
    if (trackPanelFocusFrame.current) window.cancelAnimationFrame(trackPanelFocusFrame.current)
    if (trackPanelRestoreFrame.current) window.cancelAnimationFrame(trackPanelRestoreFrame.current)
    setPanel(null)
    updateChrome('controls')

    if (!restoreFocus) return
    trackPanelRestoreFrame.current = window.requestAnimationFrame(() => {
      const target = returnTarget?.isConnected && returnTarget.matches(focusableSelector)
        ? returnTarget
        : document.querySelector<HTMLElement>('.player-progress__bar')
      focusSpatialElement(target)
      trackPanelRestoreFrame.current = null
    })
  }, [updateChrome])

  const toggleTrackPanel = useCallback((kind: 'audio' | 'subtitles') => {
    if (panel === kind) {
      closeTrackPanel()
      return
    }

    if (trackPanelRestoreFrame.current) window.cancelAnimationFrame(trackPanelRestoreFrame.current)
    trackPanelReturnFocus.current = document.querySelector<HTMLElement>(`.player-track-trigger--${kind}`)
    setPanel(kind)
    updateChrome('controls')
  }, [closeTrackPanel, panel, updateChrome])

  const moveTrackPanelFocus = useCallback((direction: Direction) => {
    const root = trackPanelRef.current
    if (!root) return false

    const closeButton = root.querySelector<HTMLElement>('.track-panel__close')
    const options = Array.from(root.querySelectorAll<HTMLElement>('.track-panel__option:not([disabled])'))
    const current = currentSpatialFocus()

    if (!current || !root.contains(current)) {
      return focusTrackPanelTarget(root.querySelector<HTMLElement>('.track-panel__option.is-active') ?? options[0] ?? closeButton)
    }

    if (direction === 'left' || direction === 'right') return true

    if (current === closeButton) {
      if (direction === 'up') {
        closeTrackPanel()
      } else {
        focusTrackPanelTarget(options[0] ?? closeButton)
      }
      return true
    }

    const currentIndex = options.indexOf(current)
    if (currentIndex < 0) {
      return focusTrackPanelTarget(options[0] ?? closeButton)
    }

    if (direction === 'up') {
      focusTrackPanelTarget(currentIndex === 0 ? closeButton : options[currentIndex - 1])
    } else {
      focusTrackPanelTarget(options[Math.min(options.length - 1, currentIndex + 1)])
    }
    return true
  }, [closeTrackPanel, focusTrackPanelTarget])

  useEffect(() => {
    if (!panel || !controls) return
    if (trackPanelFocusFrame.current) window.cancelAnimationFrame(trackPanelFocusFrame.current)
    trackPanelFocusFrame.current = window.requestAnimationFrame(() => {
      const root = trackPanelRef.current
      focusTrackPanelTarget(
        root?.querySelector<HTMLElement>('.track-panel__option.is-active')
          ?? root?.querySelector<HTMLElement>('.track-panel__option'),
      )
      trackPanelFocusFrame.current = null
    })
    return () => {
      if (trackPanelFocusFrame.current) window.cancelAnimationFrame(trackPanelFocusFrame.current)
      trackPanelFocusFrame.current = null
    }
  }, [controls, focusTrackPanelTarget, panel])

  useLayoutEffect(() => {
    if (chrome === 'hidden') {
      clearSpatialFocus()
      playerPageRef.current?.focus({ preventScroll: true })
      return
    }
    focusSpatialElement(playerPageRef.current?.querySelector<HTMLElement>(
      chrome === 'topbar' ? '.player-back' : '.player-progress__bar',
    ))
  }, [chrome])

  useEffect(() => {
    scheduleHide()
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
      if (volumeTimer.current) window.clearTimeout(volumeTimer.current)
      if (trackPanelFocusFrame.current) window.cancelAnimationFrame(trackPanelFocusFrame.current)
    }
  }, [scheduleHide])

  useEffect(() => () => {
    if (trackPanelRestoreFrame.current) window.cancelAnimationFrame(trackPanelRestoreFrame.current)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current
      const active = planRef.current
      publishNativePlaybackState(statusRef.current)
      if (!video || !active || !startedPlans.current.has(planKey(active))) return
      void reportPlaybackProgress(active, video.paused, positionTicks()).catch(() => undefined)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [planKey, positionTicks, publishNativePlaybackState, reportPlaybackProgress])

  useEffect(() => {
    const onVisibilityChange = () => {
      const active = planRef.current
      if (!active || !document.hidden || !startedPlans.current.has(planKey(active))) return
      void reportPlaybackProgress(active, true, positionTicks()).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [planKey, positionTicks, reportPlaybackProgress])

  useLayoutEffect(() => () => {
    stopPlan(planRef.current, statusRef.current === 'error')
  }, [stopPlan])

  useEffect(() => {
    const onPageHide = () => stopPlan(planRef.current, statusRef.current === 'error')
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      stopPlan(planRef.current, statusRef.current === 'error')
    }
  }, [stopPlan])

  useEffect(() => {
    const listener = (event: Event) => {
      const key = (event as CustomEvent<string>).detail
      if (panel) {
        reveal()
        if (key === 'left' || key === 'right' || key === 'up' || key === 'down') {
          moveTrackPanelFocus(key)
          return
        }
        if (key === 'enter') {
          const active = currentSpatialFocus()
          if (active && trackPanelRef.current?.contains(active)) {
            active.click()
          } else {
            moveTrackPanelFocus('down')
          }
          return
        }
        if (key === 'back') {
          closeTrackPanel()
          return
        }
      }

      const phase = chromeRef.current
      if (key === 'left' || key === 'right') {
        if (phase === 'hidden') return seek(key === 'left' ? -10 : 10, false)
        if (phase === 'topbar') return
        const active = currentSpatialFocus()
        const progressFocused = active instanceof HTMLElement
          && active.matches('.player-progress__bar')

        if (progressFocused) {
          return seek(key === 'left' ? -10 : 10)
        }

        reveal()
        if (!movePlayerFocus(key)) moveFocus(key)
        return
      }
      if (key === 'down') {
        const active = currentSpatialFocus()
        reveal()
        // A newly revealed control bar receives focus after its inert state clears.
        if (phase !== 'controls') return
        if (active?.matches('.player-back')) {
          focusSpatialElement(document.querySelector<HTMLElement>('.player-progress__bar'))
        } else if (!movePlayerFocus('down')) moveFocus('down')
        return
      }
      if (key === 'up') {
        if (phase === 'hidden') {
          updateChrome('topbar')
          scheduleHide()
          return
        }
        if (phase === 'topbar') {
          scheduleHide()
          return
        }
        if (currentSpatialFocus()?.matches('.player-progress__bar')) {
          if (hideTimer.current) window.clearTimeout(hideTimer.current)
          updateChrome('hidden')
          return
        }
        reveal()
        if (!movePlayerFocus('up')) moveFocus('up')
        return
      }
      if (key === 'enter') {
        const active = currentSpatialFocus()
        if (phase !== 'hidden' && active) {
          active.click()
        } else {
          togglePlayback()
          reveal()
        }
        return
      }
      if (key === 'back') {
        onBack()
      }
    }
    window.addEventListener('lucent-player-key', listener)
    return () => window.removeEventListener('lucent-player-key', listener)
  }, [closeTrackPanel, moveTrackPanelFocus, onBack, panel, reveal, scheduleHide, seek, togglePlayback, updateChrome])

  useEffect(() => {
    const listener = (event: Event) => {
      const command = String((event as CustomEvent<string>).detail ?? '')
      const seconds = parseSeekCommand(command)
      if (seconds !== null) {
        if (circularSeekEnabled()) seek(seconds)
        return
      }
      if (!command.startsWith('volume:')) return
      const next = Number(command.slice('volume:'.length))
      if (!Number.isFinite(next)) return
      setVolume(Math.max(0, Math.min(100, Math.round(next))))
      setVolumeVisible(true)
      if (volumeTimer.current) window.clearTimeout(volumeTimer.current)
      volumeTimer.current = window.setTimeout(() => setVolumeVisible(false), 1350)
    }
    window.addEventListener('rayneo-remote-command', listener)
    return () => window.removeEventListener('rayneo-remote-command', listener)
  }, [circularSeekEnabled, seek])

  const chooseTrack = useCallback((kind: 'audio' | 'subtitles', index: number) => {
    const active = planRef.current
    const video = videoRef.current
    if (!active || !video) return
    const shouldPlay = !video.paused
    const nextSelection: PlaybackSelection = {
      mediaSourceId: active.mediaSourceId,
      audioStreamIndex: kind === 'audio' ? index : active.audioStreamIndex,
      subtitleStreamIndex: kind === 'subtitles' ? index : active.subtitleStreamIndex,
    }
    closeTrackPanel()
    stopPlan(active)
    void prepare(positionTicks(), nextSelection, shouldPlay)
  }, [closeTrackPanel, positionTicks, prepare, stopPlan])

  const handlePlaying = useCallback(() => {
    const active = planRef.current
    setHasVideoFrame(!(videoRef.current instanceof NativePlayback) || videoRef.current.readyState >= 2)
    updateStatus('playing')
    setError('')
    if (active) {
      const key = planKey(active)
      if (!startedPlans.current.has(key)) {
        startedPlans.current.add(key)
        void reportPlaybackStarted(active, false, positionTicks()).catch(() => undefined)
      }
    }
    scheduleHide()
  }, [planKey, positionTicks, reportPlaybackStarted, scheduleHide, updateStatus])

  const handlePause = useCallback(() => {
    const video = videoRef.current
    const active = planRef.current
    if (!video || video.ended || statusRef.current === 'preparing' || statusRef.current === 'error') return
    updateStatus('paused')
    updateChrome('controls')
    if (active && startedPlans.current.has(planKey(active))) {
      void reportPlaybackProgress(active, true, positionTicks()).catch(() => undefined)
    }
  }, [planKey, positionTicks, reportPlaybackProgress, updateChrome, updateStatus])

  const handleEnded = useCallback(() => {
    desiredPlaying.current = false
    updateStatus('ended')
    updateChrome('controls')
    stopPlan(planRef.current)
  }, [stopPlan, updateChrome, updateStatus])

  useEffect(() => {
    const player = videoRef.current
    if (!(player instanceof NativePlayback)) return
    const time = () => { currentRef.current = player.currentTime; setCurrent(player.currentTime) }
    const duration = () => setTotal(player.duration)
    const loaded = () => setHasVideoFrame(true)
    const waiting = () => statusRef.current !== 'preparing' && updateStatus('buffering')
    const failed = () => {
      const state = player.snapshot
      if (state?.httpStatus === 401 || state?.httpStatus === 403) {
        postNativeMessage({ type: 'unauthorized', catalogGeneration: state.generation })
        return
      }
      failPlayback(t('原生播放器无法解码或读取当前媒体流。'))
    }
    const handlers = { playing: handlePlaying, pause: handlePause, ended: handleEnded,
      timeupdate: time, durationchange: duration, loadeddata: loaded, waiting, error: failed }
    for (const [name, handler] of Object.entries(handlers)) player.addEventListener(name, handler)
    return () => { for (const [name, handler] of Object.entries(handlers)) player.removeEventListener(name, handler) }
  }, [handlePlaying, handlePause, handleEnded, failPlayback, updateStatus])

  const progress = total > 0 ? Math.min(100, Math.max(0, current / total * 100)) : 0
  const subtitleText = useMemo(() => plan?.subtitleFormat === 'ass' ? '' : subtitleCues
    .filter((cue) => current >= cue.start && current < cue.end)
    .map((cue) => cue.text)
    .join('\n'), [current, subtitleCues, plan?.subtitleFormat])
  const titleDetail = item.original && item.original !== item.title ? item.original : item.subtitle
  const episodeLabel = item.sourceType === 'Episode'
    ? `S${String(item.parentIndexNumber ?? 0).padStart(2, '0')} E${String(item.indexNumber ?? 0).padStart(2, '0')}`
    : t(item.kind)
  const playbackMethod = plan?.playMethod === 'Transcode'
    ? t("服务器转码")
    : plan?.playMethod === 'DirectStream'
      ? t("直接串流")
      : t("直接播放")
  const formatLabel = [
    plan?.width && plan?.height ? `${plan.width}×${plan.height}` : item.resolution,
    plan?.videoCodec,
  ].filter(Boolean).join(' · ')
  const audioTracks = plan?.audioTracks ?? []
  const browserRealtime = useRealtimeSbs(browserVideoRef, plan?.playSessionId ?? '', !native && status === 'playing',
    (plan?.subtitleStreamIndex ?? -1) >= 0, infoVisible)
  const nativeRealtime = useNativeSbs(videoRef, plan?.url ?? '', infoVisible)
  const realtime = native ? nativeRealtime : browserRealtime
  const realtimeLabel = {
    off: t('实时 3D 已关闭'), 'needs-stereo': t('请先在手机上切换到 3D 显示'),
    subtitles: t('实时 3D 首版需要关闭字幕'), loading: t('正在准备实时 3D'),
    ready: t('实时 3D 等待视频帧'), frame: t('实时 3D 正在转换'),
    flat: t('等待有效深度，保持上一帧'),
    stale: t('深度更新延迟，保持上一帧'), error: t('实时 3D 不可用，请关闭后重试'),
  }[realtime.status]
  const subtitleTracks = plan?.subtitleTracks ?? []
  const statusLabel = {
    get preparing() { return t("正在加载") }, get buffering() { return t("缓冲中") }, get playing() { return t("正在播放") },
    get paused() { return t("已暂停") }, get ended() { return t("播放结束") }, get error() { return t("播放中断") },
  }[status]

  return (
    <div ref={playerPageRef} tabIndex={-1} className="player-page page-enter" onMouseMove={reveal} onClick={reveal}>
      {!native && <video
        ref={browserVideoRef}
        className={cx('player-video', !hasVideoFrame && 'player-video--pending')}
        crossOrigin="anonymous"
        controls={false}
        playsInline
        preload="auto"
        onLoadedMetadata={applyInitialSeek}
        onLoadedData={(event) => {
          if (statusRef.current !== 'preparing' && statusRef.current !== 'error'
            && event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setHasVideoFrame(true)
        }}
        onCanPlay={attemptPlay}
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={() => statusRef.current !== 'preparing' && updateStatus('buffering')}
        onTimeUpdate={(event) => { currentRef.current = event.currentTarget.currentTime; setCurrent(event.currentTarget.currentTime) }}
        onDurationChange={(event) => Number.isFinite(event.currentTarget.duration) && setTotal(event.currentTarget.duration)}
        onEnded={handleEnded}
        onError={() => failPlayback(t("浏览器无法解码当前 Jellyfin 媒体流。"))}
      />}

      {backdropMounted && <div className={cx('player-backdrop', hasVideoFrame && 'is-leaving')} aria-hidden="true">
        {!simpleUi && (item.imageUrl ?? item.backdropUrl ?? item.coverUrl) && <img src={item.imageUrl ?? item.backdropUrl ?? item.coverUrl} alt="" decoding="async" draggable={false} onError={(event) => { event.currentTarget.style.display = 'none' }} />}
      </div>}

      <div className={cx('player-chrome', chrome === 'hidden' && 'is-hidden')} inert={chrome === 'hidden'} aria-hidden={chrome === 'hidden'}>
        <header className="player-topbar">
          <FocusButton className="player-back" variant="round" sound="back" label={t("退出播放器")} onClick={onBack}><ArrowLeft size={22} /></FocusButton>
          <div className="player-title"><small>{t("正在播放 ·")} {episodeLabel}</small><strong>{item.title} <span>·</span> {titleDetail}</strong></div>
          {plan && <div className="player-direct"><span /> {playbackMethod} <i /> {plan.transcoding ? t("源格式 ") : ''}{formatLabel}</div>}
          <SystemClock active={chrome !== 'hidden'} />
        </header>
      </div>

      {realtime.enabled && (controls || infoVisible) && <aside className="realtime-sbs-debug" role="status">
        <strong>{realtimeLabel}</strong>
        {infoVisible && !native && <><small>{t('深度计算')} {realtime.metrics.nativeMs.toFixed(1)} ms · {t('帧往返')} {realtime.metrics.roundTripMs.toFixed(1)} ms</small>
          <DepthPreview value={realtime.depth} /></>}
      </aside>}
      <VideoInfoOverlay visible={infoVisible} plan={status === 'preparing' ? null : plan} failed={status === 'error'} videoRef={browserVideoRef} nativeRef={videoRef} hlsRef={hlsRef} sourceRef={infoSourceRef} />

      {(status === 'preparing' || status === 'buffering') && (
        <div className="player-state" role="status">
          <LoaderCircle className="is-spinning" size={34} />
          <strong>{hasVideoFrame ? t("正在缓冲") : t("正在加载视频")}</strong>
          <small>{episodeLabel} · {item.original || item.title}</small>
        </div>
      )}

      {status === 'error' && (
        <div className="player-error glass-panel" role="alert">
          <Info size={30} />
          <small>PLAYBACK INTERRUPTED</small>
          <h2>{t("播放暂时中断")}</h2>
          <p>{error}</p>
          <div>
            <FocusButton variant="primary" autoFocusTarget icon={<RefreshCw size={18} />} onClick={() => { void prepare(positionTicks(), { mediaSourceId: plan?.mediaSourceId, audioStreamIndex: plan?.audioStreamIndex, subtitleStreamIndex: plan?.subtitleStreamIndex }) }}>{t("重新尝试")}</FocusButton>
            <FocusButton variant="glass" sound="back" onClick={onBack}>{t("返回详情")}</FocusButton>
          </div>
        </div>
      )}

      {volumeMounted && (
        <div className={cx('player-volume', 'glass-panel', !volumeVisible && 'is-leaving', volume === 0 && 'is-muted')}
          role="status" aria-atomic="true" aria-hidden={!volumeVisible}>
          {volume === 0 ? <VolumeX size={24} /> : volume < 50 ? <Volume1 size={24} /> : <Volume2 size={24} />}
          <span><small>{volume === 0 ? t("已静音") : t("媒体音量")}</small><strong>{volume}<em>%</em></strong></span>
          <i aria-hidden="true"><b style={{ transform: `scaleX(${volume / 100})` }} /></i>
        </div>
      )}

      {subtitleLoadError && (
        <div className="player-subtitle-error glass-panel" role="status">
          <Captions size={18} />
          <span>{t("字幕加载失败，请重新选择字幕轨")}</span>
        </div>
      )}

      {feedback && (
        <div
          key={feedback.id}
          className={cx('seek-feedback', `seek-feedback--${feedback.direction}`)}
          role="status"
          aria-live="polite"
          aria-label={t("{0} {1} 秒", { 0: feedback.direction === 'forward' ? t("快进") : t("快退"), 1: feedback.seconds })}
        >
          <div className="seek-feedback__field" aria-hidden="true"><i /><i /><i /></div>
          <div className="seek-feedback__content">
            <span className="seek-feedback__icon">
              {feedback.direction === 'forward' ? <FastForward size={42} /> : <Rewind size={42} />}
            </span>
            <span className="seek-feedback__copy">
              <small>{feedback.direction === 'forward' ? t("快进") : t("快退")}</small>
              <strong>{feedback.seconds} <em>{t("秒")}</em></strong>
              <b>{formatTime(current)}</b>
            </span>
          </div>
        </div>
      )}

      {status !== 'preparing' && plan?.subtitleFormat === 'ass' && plan.subtitleUrl && <AssSubtitles key={`${plan.playSessionId}:${plan.subtitleStreamIndex}`} videoRef={videoRef} url={plan.subtitleUrl} fontUrls={plan.subtitleFontUrls} onError={setSubtitleLoadError} />}

      <div ref={bottomChromeRef} className={cx('player-chrome player-chrome--bottom', !controls && 'is-hidden')} inert={!controls} aria-hidden={!controls}>
        {panel && controls && (
          <aside ref={trackPanelRef} className="track-panel glass-panel" role="dialog" aria-modal="true" aria-labelledby="track-panel-title">
            <header><div><small>PLAYBACK OPTIONS</small><h2 id="track-panel-title">{panel === 'audio' ? t("选择音轨") : t("选择字幕")}</h2></div><FocusButton className="track-panel__close" variant="round" sound="close" label={t("关闭面板")} onClick={() => closeTrackPanel()}><X size={20} /></FocusButton></header>
            <div className="track-list">
              {(panel === 'audio'
                ? audioTracks
                : [{ index: -1, get label() { return t("关闭字幕") }, language: '', codec: '', default: false, forced: false, external: false, text: true }, ...subtitleTracks]
              ).map((track) => {
                const selected = panel === 'audio'
                  ? plan?.audioStreamIndex === track.index
                  : plan?.subtitleStreamIndex === track.index
                return <FocusButton key={`${panel}-${track.index}`} className="track-panel__option" variant="glass" active={selected} trailing={selected ? <Check size={19} /> : undefined} onClick={() => chooseTrack(panel, track.index)}>{track.label}</FocusButton>
              })}
            </div>
          </aside>
        )}
        <section className="player-controls glass-panel">
          <div className="player-progress" style={{ '--played': `${progress}%` } as CSSProperties}>
            <span className="player-progress__time">{formatTime(current)}</span>
            <button type="button" data-focusable="true" aria-label={t("播放进度，左右滑动调整十秒，手机顺时针快进、逆时针快退，转得越快调整越多，单击播放或暂停")} className="player-progress__bar" onClick={() => { togglePlayback(); reveal() }}><i><b /></i></button>
            <span className="player-progress__time">{formatTime(total)}</span>
          </div>
          <div className="player-control-row">
            <div className="player-control-group">
              <FocusButton variant="round" disabled={!previousItem} label={t("上一集")} onClick={() => previousItem && onPlayItem(previousItem, true)}><SkipBack size={21} /></FocusButton>
              <FocusButton variant="round" label={t("后退十秒")} onClick={() => seek(-10)}><RotateCcw size={22} /></FocusButton>
              <FocusButton variant="round" disabled={status === 'preparing'} className="player-play" autoFocusTarget label={playing ? t("暂停") : status === 'ended' ? t("重新播放") : t("播放")} onClick={() => { togglePlayback(); reveal() }}>{playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}</FocusButton>
              <FocusButton variant="round" label={t("前进十秒")} onClick={() => seek(10)}><FastForward size={22} /></FocusButton>
              <FocusButton variant="round" disabled={!nextItem} label={t("下一集")} onClick={() => nextItem && onPlayItem(nextItem, true)}><SkipForward size={21} /></FocusButton>
            </div>
            <div className="player-now"><span className={cx('playing-bars', !playing && 'is-paused')}><i /><i /><i /></span><div><small>{statusLabel}</small><strong>{titleDetail}</strong></div></div>
            <div className="player-control-group player-control-group--right">
              <FocusButton sound={panel === 'audio' ? 'close' : 'open'} className="player-track-trigger--audio" variant="round" label={t("音轨")} disabled={!audioTracks.length || status === 'preparing'} active={panel === 'audio'} onClick={() => toggleTrackPanel('audio')}><AudioLines size={21} /></FocusButton>
              <FocusButton sound={panel === 'subtitles' ? 'close' : 'open'} className="player-track-trigger--subtitles" variant="round" label={t("字幕")} disabled={!subtitleTracks.length || status === 'preparing'} active={panel === 'subtitles'} onClick={() => toggleTrackPanel('subtitles')}><Captions size={21} /></FocusButton>
              {realtime.available && <FocusButton className="player-realtime-trigger" variant="round" label={t('实时 3D')} active={realtime.enabled} onClick={() => { realtime.toggle(); reveal() }}><span>3D</span></FocusButton>}
              <FocusButton sound={infoVisible ? 'toggle-off' : 'toggle-on'} className="player-info-trigger" variant="round" label={t("视频信息")} active={infoVisible} onClick={() => { onToggleInfo(); reveal() }}><Info size={21} /></FocusButton>
            </div>
          </div>
          <div className="player-hints" aria-label={t("手机触控板手势")}>
            <span><MoveHorizontal size={17} aria-hidden="true" /><b>{t("进度条聚焦")}</b>  {t("环形转动变速调整 · 左右滑动 10 秒")}</span>
            <span><MoveVertical size={17} aria-hidden="true" /><b>{t("上下滑动")}</b>  {t("进度条上滑收起 · 再上滑返回按钮")}</span>
            <span><Pointer size={17} aria-hidden="true" /><b>{t("单击")}</b>  {t("确认 / 播放暂停")}</span>
            <span><RotateCcw size={17} aria-hidden="true" /><b>{t("双击")}</b> {panel ? t("关闭选项") : t("返回详情")}</span>
          </div>
        </section>
      </div>
      <div className={cx('screen-subtitle', !subtitleText && 'is-hidden')} style={{ fontSize: subtitleFontSize(subtitleSize) }} aria-live="off">{subtitleText}</div>
    </div>
  )
}

function RemoteHint({ dark = false }: { dark?: boolean }) {
  return (
    <div className={cx('remote-hint', dark && 'remote-hint--dark')}>
      <span><Move size={16} aria-hidden="true" />  {t("滑动移动")}</span>
      <span><Pointer size={16} aria-hidden="true" />  {t("单击确认")}</span>
      <span><RotateCcw size={16} aria-hidden="true" />  {t("双击返回")}</span>
      {import.meta.env.DEV && <span className="remote-hint__demo">{t("1–5 页面预览")}</span>}
    </div>
  )
}

function RuntimeGate({
  simpleUi,
  status,
  error,
  onRetry,
}: {
  simpleUi: boolean
  status: JellyfinUiStatus
  error: string
  onRetry: () => void
}) {
  const busy = status === 'booting' || status === 'loading'
  const title = status === 'no-session'
    ? t("请在手机端登录 Jellyfin")
    : status === 'error'
      ? t("媒体库连接失败")
      : t("正在点亮你的媒体库")
  const description = status === 'no-session'
    ? t("眼镜画面已经就绪。请使用手机端完成账号登录，媒体内容会自动出现在这里。")
    : status === 'error'
      ? error || t("无法读取 Jellyfin 数据，请检查手机端登录状态与服务器网络。")
      : t("正在读取媒体库、观看进度与收藏状态。")

  return (
    <div className="runtime-gate page-enter">
      {!simpleUi && <AmbientBackground tone={2} dim={0.62} />}
      <header className="runtime-gate__header"><Logo /></header>
      <main className="runtime-gate__content glass-panel">
        <div className={cx('runtime-gate__orb', busy && 'is-loading')}>
          {busy ? <LoaderCircle className="is-spinning" size={38} /> : <Server size={38} />}
        </div>
        <small>{status === 'no-session' ? 'PHONE SIGN-IN REQUIRED' : busy ? 'SYNCING JELLYFIN' : 'CONNECTION INTERRUPTED'}</small>
        <h1>{title}</h1>
        <p>{description}</p>
        {!busy && status === 'error' && (
          <FocusButton variant="primary" autoFocusTarget icon={<RefreshCw size={20} />} onClick={onRetry}>{t("重新连接")}</FocusButton>
        )}
        {status === 'no-session' && <div className="runtime-gate__signal"><span />  {t("手机端登录完成后自动刷新")}</div>}
      </main>
      <RemoteHint dark />
    </div>
  )
}

export default function App() {
  useLanguage()
  const jellyfin = useJellyfin()
  const uiTheme = normalizeUiTheme(jellyfin.runtime?.uiTheme ?? document.documentElement.dataset.uiTheme)
  const simpleUi = uiTheme === 'simpleUI'
  const subtitleSize = normalizeSubtitleSize(jellyfin.runtime?.subtitleSize)
  useLayoutEffect(() => { applyUiTheme(uiTheme) }, [uiTheme])
  const [page, setPage] = useState<Page>('home')
  const [tutorialSeen, setTutorialSeen] = useState(hasSeenRemoteTutorial)
  const restoreTutorialFocus = useRef(false)
  const restoreSettingsFocus = useRef(false)
  const tutorialActive = jellyfin.status === 'ready' && Boolean(jellyfin.snapshot)
    && (page === 'tutorial' || (page === 'home' && !tutorialSeen))
  const [history, setHistory] = useState<Page[]>([])
  const [selected, setSelected] = useState<MediaItem>(demoFeatured)
  const [backdropItem, setBackdropItem] = useState<MediaItem>(demoFeatured)
  const [homeFocusRegion, setHomeFocusRegion] = useState<HomeFocusRegion>('hero')
  const browsePath = useRef<BrowsePath>([])
  const [browseEntry, setBrowseEntry] = useState<MediaItem | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPane, setSearchPane] = useState<SearchPane>('keyboard')
  const [searchKeyboardMode, setSearchKeyboardMode] = useState<SearchKeyboardMode>('letters')
  const [searchKeyboardFocusId, setSearchKeyboardFocusId] = useState('letters-A')
  const [searchResultFocusId, setSearchResultFocusId] = useState('')
  const [searchRecentSeriesIds, setSearchRecentSeriesIds] = useState<string[]>([])
  const [searchEpisodeHint, setSearchEpisodeHint] = useState<SearchEpisodeHint | null>(null)
  const [phoneKeyboardState, setPhoneKeyboardState] = useState<PhoneKeyboardState>('opening')
  const [detail, setDetail] = useState<DetailSnapshot | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [playback, setPlayback] = useState<PlaybackRequest | null>(null)
  const [videoInfoVisible, setVideoInfoVisible] = useState(false)
  useEffect(() => {
    if (page !== 'player' || jellyfin.status !== 'ready') setVideoInfoVisible(false)
  }, [page, jellyfin.status])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastTimer = useRef<number | null>(null)
  const detailGeneration = useRef(0)
  const playbackKey = useRef(0)

  const serverName = jellyfin.runtime?.session?.serverName
    || jellyfin.runtime?.session?.serverUrl.replace(/^https?:\/\//i, '')
    || 'Jellyfin'
  const userName = jellyfin.runtime?.session?.userName || t("Jellyfin 用户")
  const searchSessionKey = jellyfin.runtime?.session
    ? `${jellyfin.runtime.session.serverUrl}\n${jellyfin.runtime.session.userId}\n${jellyfin.runtime.session.accessToken}`
    : ''

  useEffect(() => {
    detailGeneration.current += 1
    setPage('home')
    setHistory([])
    setDetail(null)
    setDetailError('')
    setPlayback(null)
    setVideoInfoVisible(false)
    setBrowseEntry(null)
    browsePath.current = []
    setToast(null)
    setSearchQuery('')
    setSearchPane('keyboard')
    setSearchKeyboardMode('letters')
    setSearchKeyboardFocusId('letters-A')
    setSearchResultFocusId('')
    setSearchRecentSeriesIds([])
    setSearchEpisodeHint(null)
    setPhoneKeyboardState('opening')
  }, [searchSessionKey])

  const searchPrioritySeriesIds = useMemo(() => {
    const shelfIds = jellyfin.snapshot?.shelves
      .filter((shelf) => shelf.id === 'resume' || shelf.id === 'next-up')
      .flatMap((shelf) => shelf.items.map((item) => (
        item.sourceType === 'Series' ? item.id : item.seriesId ?? ''
      ))) ?? []
    return Array.from(new Set([...searchRecentSeriesIds, ...shelfIds].filter(Boolean)))
  }, [jellyfin.snapshot, searchRecentSeriesIds])

  const fallbackSeries = useMemo(
    () => jellyfin.snapshot?.allItems.filter((item) => item.sourceType === 'Series') ?? [],
    [jellyfin.snapshot?.allItems],
  )

  useEffect(() => {
    postNativeMessage({
      type: 'runtime_state',
      state: jellyfin.status,
      errorCode: jellyfin.status === 'error' ? jellyfin.errorCode : 'none',
    })
  }, [jellyfin.errorCode, jellyfin.status])

  useEffect(() => {
    if (page === 'home') setHomeFocusRegion('hero')
  }, [page])

  const searchInputActive = page === 'search'
    && !tutorialActive
    && jellyfin.status === 'ready'
    && Boolean(jellyfin.snapshot)

  useEffect(() => {
    if (!searchInputActive) return
    setPhoneKeyboardState('opening')
    return () => {
      postNativeMessage({ type: 'search_state', state: 'inactive' })
    }
  }, [searchInputActive])

  useEffect(() => {
    if (!searchInputActive) return
    postNativeMessage({
      type: 'search_state',
      state: 'active',
      query: searchQuery,
    })
  }, [searchInputActive, searchQuery])

  useEffect(() => {
    const onSearchRemoteCommand = (event: Event) => {
      if (!searchInputActive) return
      const command = event instanceof CustomEvent && typeof event.detail === 'string'
        ? event.detail
        : ''

      if (command.startsWith('search-text:')) {
        const value = command.slice('search-text:'.length)
        if (value.length <= 48 && /^[a-z0-9 ]*$/.test(value)) setSearchQuery(value)
        return
      }
      if (command === 'search-keyboard-visible') {
        setPhoneKeyboardState('visible')
        return
      }
      if (command === 'search-keyboard-hidden') {
        setPhoneKeyboardState('hidden')
        return
      }
      if (command !== 'search-submit') return

      setSearchPane('results')
      window.requestAnimationFrame(() => {
        const searchPage = document.querySelector<HTMLElement>('.series-search-page')
        const target = searchPage?.querySelector<HTMLElement>('[data-search-result="true"][data-previewed="true"]')
          ?? searchPage?.querySelector<HTMLElement>('[data-search-result="true"]')
        if (!target) return
        focusSpatialElement(target)
        target.scrollIntoView({ behavior: motionScrollBehavior(), block: 'nearest', inline: 'nearest' })
      })
    }

    window.addEventListener('rayneo-remote-command', onSearchRemoteCommand)
    return () => window.removeEventListener('rayneo-remote-command', onSearchRemoteCommand)
  }, [searchInputActive])

  useEffect(() => {
    const snapshot = jellyfin.snapshot
    if (!snapshot) return
    const available = [
      snapshot.featured,
      ...snapshot.libraries,
      ...snapshot.allItems,
      ...snapshot.favorites,
      ...snapshot.shelves.flatMap((shelf) => shelf.items),
    ]
    setSelected((current) => available.find((item) => item.id === current.id) ?? snapshot.featured)
    setBackdropItem((current) => available.find((item) => item.id === current.id) ?? snapshot.featured)
  }, [jellyfin.snapshot])

  useEffect(() => {
    if (page !== 'detail' || !selected.id) return
    const generation = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError('')
    void (async () => {
      let next = await jellyfin.loadDetail(selected.id)
      const hint = searchEpisodeHint?.seriesId === selected.id ? searchEpisodeHint : null
      if (hint?.season) {
        const requestedSeason = next.seasons.find((season) => season.indexNumber === hint.season)
        if (requestedSeason && requestedSeason.id !== next.selectedSeasonId) {
          next = await jellyfin.loadDetail(selected.id, requestedSeason.id)
        }
      }
      return next
    })().then((next) => {
      if (generation !== detailGeneration.current) return
      setDetail(next)
      setSelected(next.item)
      setBackdropItem(next.item)
    }).catch((reason) => {
      if (generation !== detailGeneration.current) return
      setDetailError(reason instanceof Error ? reason.message : t("详情加载失败。"))
    }).finally(() => {
      if (generation === detailGeneration.current) setDetailLoading(false)
    })
    return () => { detailGeneration.current += 1 }
  }, [jellyfin.loadDetail, page, searchEpisodeHint, selected.id])

  const navigate = useCallback((next: Page) => {
    if (next === page) return
    setHistory((items) => [...items, page])
    setPage(next)
    window.scrollTo({ top: 0, behavior: motionScrollBehavior() })
  }, [page])

  const navigateDirect = useCallback((next: Page) => {
    if (next === 'browse') { setBrowseEntry(null); browsePath.current = [] }
    setHistory([])
    setPage(next)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])

  const goBack = useCallback(() => {
    setHistory((items) => {
      if (items.length) {
        setPage(items[items.length - 1])
        return items.slice(0, -1)
      }
      setPage('home')
      return []
    })
    window.scrollTo({ top: 0, behavior: motionScrollBehavior() })
  }, [])

  const closeTutorial = useCallback((outcome: TutorialOutcome) => {
    rememberRemoteTutorial(outcome)
    setTutorialSeen(true)
    if (page === 'tutorial') {
      restoreTutorialFocus.current = true
      goBack()
    }
  }, [goBack, page])

  const completeTutorial = useCallback(() => {
    rememberRemoteTutorial('completed')
  }, [])

  useEffect(() => {
    if (jellyfin.status === 'ready') return
    setTutorialSeen((seen) => seen || hasSeenRemoteTutorial())
    if (page !== 'tutorial') return
    // A disconnected/invalidated session drops the in-progress practice too.
    setPage('home')
    setHistory([])
    restoreTutorialFocus.current = false
  }, [jellyfin.status, page])

  const showToast = useCallback((message: string, tone: FeedbackTone = 'info') => {
    uiSounds.play(tone === 'info' ? 'notification' : tone)
    setToast({ text: message, tone })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), tone === 'error' ? 4000 : 2400)
  }, [])

  const changeUiTheme = (value: UiTheme) => {
    if (!requestUiPreference({ type: 'set_ui_theme', value }, jellyfin.runtime)) showToast(t("设置未能保存，请重试"), 'error')
  }
  const changeSubtitleSize = (value: SubtitleSize) => {
    if (!requestUiPreference({ type: 'set_subtitle_size', value }, jellyfin.runtime)) showToast(t("设置未能保存，请重试"), 'error')
  }
  const closeSettings = useCallback(() => {
    restoreSettingsFocus.current = true
    goBack()
  }, [goBack])

  const refreshLibrary = useCallback(() => {
    void jellyfin.refresh().then((succeeded) => {
      showToast(succeeded ? t("媒体库已刷新") : t("刷新失败，请检查 Jellyfin 服务器"), succeeded ? 'success' : 'error')
    })
  }, [jellyfin.refresh, showToast])

  const manageLogin = useCallback(() => {
    postNativeMessage({ type: 'manage_login' })
    showToast(t("请在手机端管理 Jellyfin 登录"))
  }, [showToast])

  const openItem = useCallback((item: MediaItem) => {
    setSearchEpisodeHint(null)
    setSelected(item)
    setBackdropItem(item)
    setDetail(null)
    setDetailError('')
    if (item.folder) {
      browsePath.current = []
      setBrowseEntry(item)
      navigate('browse')
    } else {
      navigate('detail')
    }
  }, [navigate])

  const openSearchSeries = useCallback((
    item: MediaItem,
    hint: Omit<SearchEpisodeHint, 'seriesId'>,
  ) => {
    setSearchPane('results')
    setSearchResultFocusId(item.id)
    setSearchRecentSeriesIds((items) => [item.id, ...items.filter((id) => id !== item.id)].slice(0, 8))
    setSearchEpisodeHint({ seriesId: item.id, ...hint })
    setSelected(item)
    setBackdropItem(item)
    setDetail(null)
    setDetailError('')
    navigate('detail')
  }, [navigate])

  const navigateFromMenu = useCallback((next: Page) => {
    if (next === 'browse') { setBrowseEntry(null); browsePath.current = [] }
    navigate(next)
  }, [navigate])

  const selectSeason = useCallback((seasonId: string) => {
    const generation = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError('')
    void jellyfin.loadDetail(selected.id, seasonId).then((next) => {
      if (generation === detailGeneration.current) setDetail(next)
    }).catch((reason) => {
      if (generation === detailGeneration.current) {
        setDetailError(reason instanceof Error ? reason.message : t("剧集加载失败。"))
      }
    }).finally(() => {
      if (generation === detailGeneration.current) setDetailLoading(false)
    })
  }, [jellyfin.loadDetail, selected.id])

  const playItem = useCallback((item: MediaItem, fromStart = false) => {
    setSearchEpisodeHint(null)
    setPlayback({
      item,
      startPositionTicks: fromStart ? 0 : item.playbackPositionTicks ?? 0,
      key: ++playbackKey.current,
    })
    setBackdropItem(item)
    navigate('player')
  }, [navigate])

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (tutorialActive) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target?.matches(spatialFocusSelector)) clearSpatialFocus()
    }
    const onPointerDown = () => { if (!tutorialActive) clearSpatialFocus() }
    const onRemoteCommand = () => {
      if (tutorialActive) return
      const active = currentSpatialFocus()
      if (!active) return
      clearSpatialFocus(active)
      active.setAttribute('data-spatial-focus', 'true')
    }

    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('rayneo-remote-command', onRemoteCommand)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('rayneo-remote-command', onRemoteCommand)
      // Page nodes own their markers; the tutorial may already have focused its
      // new node before this passive cleanup runs during a scope change.
    }
  }, [tutorialActive])

  useEffect(() => {
    if (page === 'player' || tutorialActive) return
    const timer = window.setTimeout(() => {
      const tutorialReturnTarget = restoreTutorialFocus.current
        ? document.querySelector<HTMLElement>('.tutorial-launch')
        : restoreSettingsFocus.current ? document.querySelector<HTMLElement>('.settings-launch') : null
      restoreTutorialFocus.current = false
      restoreSettingsFocus.current = false
      // An early gesture/click already chose a card; do not pull focus back to the hero.
      const active = document.activeElement
      if (!tutorialReturnTarget && active instanceof HTMLElement && active.matches(focusableSelector)) return
      const target = tutorialReturnTarget ?? document.querySelector<HTMLElement>('[data-autofocus="true"]') ?? visibleFocusables()[0]
      focusSpatialElement(target)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [jellyfin.status, page, tutorialActive])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (tutorialActive) return
      const key = event.key.toLowerCase()
      const target = event.target
      if (target instanceof Element && target.matches('input, textarea') && key !== 'escape') return

      if (key === 'escape' || key === 'backspace') {
        event.preventDefault()
        if (page !== 'player' && page !== 'browse') uiSounds.play('back')
        if (page === 'player') {
          window.dispatchEvent(new CustomEvent('lucent-player-key', { detail: 'back' }))
        } else if (page === 'settings') {
          closeSettings()
        } else if (page === 'browse') {
          document.querySelector<HTMLButtonElement>('.breadcrumbs .browse-back')?.click()
        } else if (page === 'search') {
          const active = currentSpatialFocus()
          const searchPage = active?.closest<HTMLElement>('.series-search-page')
          if (active?.matches('[data-search-result="true"]') && searchPage && focusSeriesSearchKeyboard(searchPage)) {
            return
          }
          if (active?.matches('[data-search-keyboard="true"]') && searchQuery) {
            setSearchQuery((value) => value.slice(0, -1))
            return
          }
          goBack()
        } else {
          goBack()
        }
        return
      }

      if (import.meta.env.DEV && page !== 'search' && ['1', '2', '3', '4', '5'].includes(key)) {
        event.preventDefault()
        const pages: Page[] = ['home', 'browse', 'favorites', 'detail', 'player']
        navigateDirect(pages[Number(key) - 1])
        return
      }

      const directionMap: Record<string, Direction | undefined> = {
        arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right',
      }
      const direction = directionMap[key]

      if (page === 'player') {
        if (direction) {
          event.preventDefault()
          window.dispatchEvent(new CustomEvent('lucent-player-key', { detail: direction }))
        } else if (key === 'enter' || key === ' ') {
          event.preventDefault()
          window.dispatchEvent(new CustomEvent('lucent-player-key', { detail: 'enter' }))
        }
        return
      }

      if (direction) {
        event.preventDefault()
        soundNavigation(direction, () => {
          const active = currentSpatialFocus()
          if (active && moveSeriesSearchFocus(active, direction)) return
          moveFocus(direction)
        })
        return
      }

      if (key === 'enter' || key === ' ') {
        const active = currentSpatialFocus()
        if (active) {
          event.preventDefault()
          active.click()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSettings, goBack, navigateDirect, page, searchQuery, tutorialActive])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  if (jellyfin.status !== 'ready' || !jellyfin.snapshot) {
    return (
      <RuntimeGate
        simpleUi={simpleUi}
        status={jellyfin.status}
        error={jellyfin.error}
        onRetry={() => { void jellyfin.retry() }}
      />
    )
  }

  const snapshot = jellyfin.snapshot
  if (tutorialActive) return <RemoteTutorial simpleUi={simpleUi} onExit={closeTutorial} onComplete={completeTutorial} />
  const homeShelfPreview = !simpleUi && page === 'home' && homeFocusRegion === 'shelves'
  const homeBackgroundItem = homeShelfPreview ? backdropItem : snapshot.featured

  const pageNode = (() => {
    if (page === 'settings') return <div className="settings-page page-enter">
      <PageHeader active="settings" serverName={serverName} userName={userName} refreshing={jellyfin.refreshing} onNavigate={navigateFromMenu} onRefresh={refreshLibrary} onExit={manageLogin} />
      <main className="glasses-settings-page">
        <FocusButton variant="ghost" sound="back" icon={<ArrowLeft size={21} />} onClick={closeSettings}>{t("返回")}</FocusButton>
        <GlassesSettings onLanguageChange={language => { if (!requestUiPreference({ type: 'set_language', value: language }, jellyfin.runtime)) showToast(t('设置未能保存，请重试'), 'error') }} theme={uiTheme} subtitleSize={subtitleSize} onThemeChange={changeUiTheme} onSubtitleSizeChange={changeSubtitleSize} />
      </main>
      <RemoteHint />
    </div>
    if (page === 'home') return <HomePage featured={snapshot.featured} shelves={snapshot.shelves} focusRegion={homeFocusRegion} serverName={serverName} userName={userName} refreshing={jellyfin.refreshing} onNavigate={navigateFromMenu} onOpen={openItem} onPreview={setBackdropItem} onFocusRegionChange={setHomeFocusRegion} onRefresh={refreshLibrary} onExit={manageLogin} />
    if (page === 'browse' || page === 'favorites') {
      return <BrowsePage key={`${page}:${page === 'browse' ? browseEntry?.id ?? 'root' : 'root'}`} mode={page === 'browse' ? 'library' : 'favorites'} items={snapshot.libraries} favorites={snapshot.favorites} initialFolder={page === 'browse' ? browseEntry : null} initialPath={page === 'browse' ? browsePath.current : undefined} onRememberPath={(path) => { browsePath.current = path }} serverName={serverName} userName={userName} refreshing={jellyfin.refreshing} onLoadFolder={jellyfin.loadFolder} onNavigate={navigateFromMenu} onOpen={openItem} onPreview={setBackdropItem} onRefresh={refreshLibrary} onExit={manageLogin} onResetLibrary={() => { setBrowseEntry(null); browsePath.current = [] }} />
    }
    if (page === 'search') {
      const searchableSeries = jellyfin.seriesIndexStatus === 'ready'
        ? jellyfin.seriesIndex
        : jellyfin.seriesIndex.length ? jellyfin.seriesIndex : fallbackSeries
      return <SearchPage series={searchableSeries} indexStatus={jellyfin.seriesIndexStatus} prioritySeriesIds={searchPrioritySeriesIds} query={searchQuery} focusPane={searchPane} keyboardMode={searchKeyboardMode} keyboardFocusId={searchKeyboardFocusId} resultFocusId={searchResultFocusId} phoneKeyboardState={phoneKeyboardState} serverName={serverName} userName={userName} refreshing={jellyfin.refreshing} onQueryChange={setSearchQuery} onKeyboardModeChange={setSearchKeyboardMode} onKeyboardFocus={(id) => { setSearchPane('keyboard'); setSearchKeyboardFocusId(id) }} onResultFocus={(id) => { setSearchPane('results'); setSearchResultFocusId(id) }} onNavigate={navigateFromMenu} onOpen={openSearchSeries} onPreview={setBackdropItem} onRefresh={refreshLibrary} onExit={manageLogin} />
    }
    if (page === 'detail') return <DetailPage key={selected.id} item={selected} detail={detail} loading={detailLoading} error={detailError} initialEpisodeNumber={searchEpisodeHint?.seriesId === selected.id ? searchEpisodeHint.episode : undefined} serverName={serverName} userName={userName} refreshing={jellyfin.refreshing} onNavigate={(next) => next === 'home' ? goBack() : navigateFromMenu(next)} onPlay={playItem} onSelectSeason={selectSeason} onToggleFavorite={async (target, favorite) => { try { const saved = await jellyfin.setFavorite(target, favorite); if (saved) showToast(favorite ? t("已加入收藏") : t("已取消收藏"), 'success'); return saved } catch { showToast(t("收藏状态更新失败，请重试"), 'error'); return false } }} onToggleWatched={async (target, watched) => { try { const saved = await jellyfin.setPlayed(target, watched); if (saved) showToast(watched ? t("已标记为看过") : t("已标记为未看"), 'success'); return saved } catch { showToast(t("观看状态更新失败，请重试"), 'error'); return false } }} onOpen={openItem} onPreview={setBackdropItem} onRefresh={refreshLibrary} onExit={manageLogin} />
    const request = playback ?? {
      item: selected.canPlay
        ? selected
        : snapshot.allItems.find((item) => item.canPlay) ?? snapshot.featured,
      startPositionTicks: selected.playbackPositionTicks ?? 0,
      key: 0,
    }
    const episodeIndex = detail?.episodes.findIndex((episode) => episode.id === request.item.id) ?? -1
    return <PlayerPage key={request.key} simpleUi={simpleUi} subtitleSize={subtitleSize} item={request.item} startPositionTicks={request.startPositionTicks} infoVisible={videoInfoVisible} onToggleInfo={() => setVideoInfoVisible((visible) => !visible)} previousItem={episodeIndex > 0 ? detail?.episodes[episodeIndex - 1] : undefined} nextItem={episodeIndex >= 0 ? detail?.episodes[episodeIndex + 1] : undefined} preparePlayback={jellyfin.preparePlayback} reportPlaybackStarted={jellyfin.reportPlaybackStarted} reportPlaybackProgress={jellyfin.reportPlaybackProgress} reportPlaybackStopped={jellyfin.reportPlaybackStopped} onPlayItem={playItem} onBack={goBack} />
  })()

  return (
    <div className={cx('app', `app--${page}`)}>
      {page !== 'player' && page !== 'settings' && (!simpleUi || (page === 'home' && homeFocusRegion === 'hero')) && (
        <AmbientBackground
          simpleUi={simpleUi}
          tone={page === 'home' ? homeBackgroundItem.art : backdropItem.art}
          imageUrl={page === 'home'
            ? homeBackgroundItem.coverUrl ?? homeBackgroundItem.imageUrl ?? homeBackgroundItem.backdropUrl
            : page === 'detail'
              ? backdropItem.imageUrl ?? backdropItem.coverUrl ?? backdropItem.backdropUrl
              : backdropItem.backdropUrl}
          dim={page === 'home' ? homeShelfPreview ? 0.55 : 0.94 : page === 'detail' ? 0.55 : 0.42}
          homeCover={page === 'home' && !homeShelfPreview}
          preview={homeShelfPreview || page === 'detail'}
        />
      )}
      {pageNode}
      {page !== 'player' && <SystemClock overlay />}
      <Toast message={toast} />
      <svg className="svg-filters" aria-hidden="true">
        <filter id="liquid-edge" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.06" numOctaves="2" seed="8" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="B" />
        </filter>
      </svg>
    </div>
  )
}
