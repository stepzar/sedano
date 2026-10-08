/**
 * Inline stroke icons (16px grid, 1.6 stroke).
 *
 * Kept in one place so the icon language stays consistent and the app keeps
 * zero icon dependencies.
 */
import { useId } from 'react'
import type { ReactNode, SVGProps } from 'react'

/** Every icon accepts `size` on top of the usual SVG attributes. */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ children, size = 15, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.8" cy="6.8" r="4.2" />
    <path d="M10.2 10.2 13.5 13.5" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Svg>
)

/** A cog, so "Settings" never reads as the theme control next to it. */
export const IconSettings = (p: IconProps) => (
  <Svg viewBox="0 0 24 24" {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
)

export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
    <path d="M6.2 2.8v10.4" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.9" />
    <path d="M8 1.5v1.4M8 13.1v1.4M2.9 2.9l1 1M12.1 12.1l1 1M1.5 8h1.4M13.1 8h1.4M2.9 13.1l1-1M12.1 3.9l1-1" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 9.6a5.6 5.6 0 0 1-6.8-6.8 5.7 5.7 0 1 0 6.8 6.8Z" />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3.4M4.2 7.2 8 3.4l3.8 3.8" />
  </Svg>
)

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" />
  </Svg>
)

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6Z" />
  </Svg>
)

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 4.4 5.4 7l-2.8 2.6" />
    <path d="M7.4 10.4h6" />
  </Svg>
)

export const IconAgent = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5.6" width="8" height="6.4" rx="1.8" />
    <path d="M8 5.6V3.2M6.2 8.6v.8M9.8 8.6v.8" />
  </Svg>
)

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.8" y="5.8" width="7.6" height="7.6" rx="1.6" />
    <path d="M10.2 3.6a1.6 1.6 0 0 0-1.6-1.6H4.2A1.6 1.6 0 0 0 2.6 3.6v4.4a1.6 1.6 0 0 0 1.6 1.6" />
  </Svg>
)

export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.6" y="2.6" width="4.8" height="7.6" rx="2.4" />
    <path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v1.6M6 13.6h4" />
  </Svg>
)

export const IconSpinner = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
    <path d="M13.4 2.8v3h-3" />
  </Svg>
)

/** More actions for the current session. */
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.7" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
)

/** A folder, for the file tree of the session you are in. */
export const IconFiles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 4.6a1.4 1.4 0 0 1 1.4-1.4h2.4l1.3 1.6h5.1a1.4 1.4 0 0 1 1.4 1.4v5.2a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z" />
  </Svg>
)

/** The disclosure arrow of a tree row: points right when closed, rotates open. */
export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.6 10.4 8 6 12.4" />
  </Svg>
)

/** The chevron of a select: points down when closed, up when open. */
export const IconCaret = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.7 6.1 8 10.4l4.3-4.3" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.2 4.4a1.3 1.3 0 0 1 1.3-1.3h2.5l1.2 1.5h4.9a1.3 1.3 0 0 1 1.3 1.3v5.6a1.3 1.3 0 0 1-1.3 1.3H3.5a1.3 1.3 0 0 1-1.3-1.3z" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 2.9a1.2 1.2 0 0 1 1.2-1.2h4.1l3.4 3.4v7.9a1.2 1.2 0 0 1-1.2 1.2H4.8a1.2 1.2 0 0 1-1.2-1.2z" />
    <path d="M8.8 1.8v3.3h3.4" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 8.6 6.4 11.6 12.6 4.6" />
  </Svg>
)

/* ------------------------------------------------------------------ */
/* Harness marks                                                       */
/* ------------------------------------------------------------------ */

/**
 * Each harness's real logo, so a session says which CLI it is at a glance.
 *
 * Brand-coloured logos set their colour through a `brand-*` class (styles.css)
 * and paint with `currentColor`, so a surface that tints marks by state (the
 * limits bar) can still override it. Black-on-white logos carry `brand-mono`
 * and follow the theme's text colour, so they stay visible in dark mode.
 */
function Logo({ children, size = 15, viewBox = '0 0 24 24', className, ...rest }: IconProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      aria-hidden="true"
      className={className ? `brand-logo ${className}` : 'brand-logo'}
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Merge the caller's class with the brand's. */
const brand = (name: string, p: IconProps) => (p.className ? `${name} ${p.className}` : name)

// Source: https://unpkg.com/@lobehub/icons-static-svg/icons/claude-color.svg (same mark as simple-icons "claude")
export const IconClaude = (p: IconProps) => (
  <Logo {...p} className={brand('brand-claude', p)}>
    <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
  </Logo>
)

// Codex is OpenAI's CLI, so it wears the OpenAI mark.
// Source: https://unpkg.com/@lobehub/icons-static-svg/icons/openai.svg
export const IconCodex = (p: IconProps) => (
  <Logo {...p} className={brand('brand-mono', p)}>
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </Logo>
)

// Command Code's app icon: a rounded square with the ⌘ cut out of it.
// Source: https://commandcode.ai/favicon/2024/safari-pinned-tab.svg (potrace output, flattened with svgo)
export const IconCommand = (p: IconProps) => (
  <Logo {...p} viewBox="0 0 700 700" className={brand('brand-mono', p)}>
    <path d="M230.5.6A749 749 0 0 0 141.2 8C81.4 18.3 44.9 43 24 87.5c-12.6 26.7-18.6 57.6-22.2 113-1.9 28.7-1.8 266.9 0 295C7.1 574.9 19 613 48.2 643.6c28.6 29.8 67.2 43.7 136.7 48.9 61.6 4.7 269.4 4.6 326.7 0 68.5-5.6 105.6-18.6 133.9-47C674.4 616.6 687.9 577 693 506a3356 3356 0 0 0 2.7-191.5c-.6-86.8-1.3-110.2-4.2-141.7-5.5-58.9-18.8-95-44.8-121.6C616.2 20.1 578.9 7.7 498 1.9 483.9.9 255.2-.2 230.5.6m3.3 135a84 84 0 0 1 64.6 64.6c1.2 5.7 1.6 13.6 1.6 30.3V253h94.8l.5-24.3c.4-20.1.8-25.5 2.5-31.8a83 83 0 0 1 44.7-54.5 66 66 0 0 1 37-7.9c14.3.1 15.4.2 24.5 3.3a84 84 0 0 1 55.2 58.7 96 96 0 0 1-.1 41 85 85 0 0 1-51.1 57.2c-11.3 4.3-19.4 5.3-43.1 5.3H443v94.8l23.8.5c25.3.5 31 1.4 43.2 6.4a85 85 0 0 1 49.5 57.6 85 85 0 0 1-8.8 60.7 100 100 0 0 1-30.7 30.7 83 83 0 0 1-116.9-37.9c-6.3-13.4-7.4-20-7.9-46.6l-.4-23.2H300v21.9c0 14.9-.5 24.3-1.4 29.4a84 84 0 0 1-61.1 64.9c-11.2 3-29.8 3-41 0a83.2 83.2 0 0 1 .4-161.4c6.3-1.7 11.7-2.1 31.9-2.5l24.2-.5V300h-22.5c-25.2 0-32.9-1.1-45.2-6.2a83.2 83.2 0 0 1 14.2-158.1c9.3-2 24.8-2.1 34.3-.1" />
    <path d="M208 182.6a35.6 35.6 0 0 0-2.5 68.1c4.2 1.5 8.4 1.8 26 1.8h21v-21c0-17.6-.3-21.8-1.8-26a37 37 0 0 0-25.2-23 28 28 0 0 0-17.5.1m262.5-.2a34 34 0 0 0-17.8 10.5c-8.6 9.2-9.1 11.2-9.5 37.3l-.3 22.8h18.5c26.4 0 33.7-2 42.9-11.9 7.4-7.9 9.2-12.7 9.2-24.1 0-8.3-.3-10.2-2.7-15a36.4 36.4 0 0 0-40.3-19.6M300 347.5V395h95v-95h-95zM205.1 445a28 28 0 0 0-12.9 8.4c-17.8 16.7-12.7 46.3 9.8 57.4 4.8 2.4 6.7 2.7 15 2.7 11.4 0 16.2-1.8 24.1-9.2 9.9-9.2 11.9-16.5 11.9-42.8V443h-21.2c-18.4.1-22 .3-26.7 2m238.1 20.2.3 22.4 3.3 6.6c3.8 7.7 9.2 13 17.1 16.7 4.8 2.2 7 2.6 14.6 2.6 8.2 0 9.7-.3 15.7-3.3 7.7-3.8 13-9.2 16.7-17.1 2.2-4.7 2.6-7 2.6-14.6s-.4-9.9-2.6-14.6c-3.7-7.9-9-13.3-16.7-17.1l-6.6-3.3-22.4-.3-22.3-.3z" />
  </Logo>
)

// The same sparkle painted four times: a blue base and three fading colour washes.
// Source: https://unpkg.com/@lobehub/icons-static-svg/icons/gemini-color.svg
const GEMINI_SPARKLE =
  'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z'

export function IconGemini(p: IconProps) {
  // Gradient ids are per instance: a shared id breaks every copy once the first
  // one sits in a hidden subtree.
  const id = useId()
  return (
    <Logo {...p} className={brand('brand-gemini', p)}>
      <defs>
        <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="7" x2="11" y1="15.5" y2="12">
          <stop stopColor="#08B962" />
          <stop offset="1" stopColor="#08B962" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}r`} gradientUnits="userSpaceOnUse" x1="8" x2="11.5" y1="5.5" y2="11">
          <stop stopColor="#F94543" />
          <stop offset="1" stopColor="#F94543" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}y`} gradientUnits="userSpaceOnUse" x1="3.5" x2="17.5" y1="13.5" y2="12">
          <stop stopColor="#FABC12" />
          <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={GEMINI_SPARKLE} />
      <path className="brand-wash" d={GEMINI_SPARKLE} fill={`url(#${id}g)`} />
      <path className="brand-wash" d={GEMINI_SPARKLE} fill={`url(#${id}r)`} />
      <path className="brand-wash" d={GEMINI_SPARKLE} fill={`url(#${id}y)`} />
    </Logo>
  )
}

// Source: https://unpkg.com/@lobehub/icons-static-svg/icons/grok.svg
export const IconGrok = (p: IconProps) => (
  <Logo {...p} className={brand('brand-mono', p)}>
    <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
  </Logo>
)

// The opencode block: a frame with its lower inner square half-filled.
// Source: https://opencode.ai/favicon.svg (scaled from its 512 grid to 24)
export const IconOpencode = (p: IconProps) => (
  <Logo {...p} className={brand('brand-mono', p)}>
    <path fillRule="evenodd" d="M20 22H4V2h16zM16 6H8v12h8z" />
    <path d="M16 14v4H8v-4z" opacity="0.4" />
  </Logo>
)

// Source: https://freebuff.com (the header's compact mark, viewBox 0 0 77.18 77.19)
export const IconFreebuff = (p: IconProps) => (
  <Logo {...p} viewBox="0 0 77.18 77.19" className={brand('brand-mono', p)}>
    <path d="M77.18 0v19.3H19.3v57.89H0V0z" />
    <path d="M63.62 24.89v19.3h-19.3v33h-19.29V24.89z" />
  </Logo>
)

/* File changes in a turn header: a document with what happened to it. */
export const IconFileEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.2H4.4a1.2 1.2 0 0 0-1.2 1.2v9.2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.5z" />
    <path d="m6 10.4 3.4-3.4 1.2 1.2-3.4 3.4H6z" />
  </Svg>
)

export const IconFileAdd = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.2H4.4a1.2 1.2 0 0 0-1.2 1.2v9.2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.5z" />
    <path d="M8 7v4.4M5.8 9.2h4.4" />
  </Svg>
)

export const IconFileRemove = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.2H4.4a1.2 1.2 0 0 0-1.2 1.2v9.2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.5z" />
    <path d="M5.8 9.2h4.4" />
  </Svg>
)

/* Work-area kinds: one small glyph per kind of row, so a tool, a subagent,
   reasoning and bookkeeping can be told apart before a word is read. */

/** A generic tool call (a wrench). */
export const IconTool = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.9 2.4a3.2 3.2 0 0 0-3.6 4.3L2.6 10.4a1.3 1.3 0 0 0 1.9 1.9l3.7-3.7a3.2 3.2 0 0 0 4.3-3.6l-1.9 1.9-1.6-.3-.3-1.6z" />
  </Svg>
)

/** A run of mixed tool calls (stacked layers). */
export const IconStack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.4 13.6 5 8 7.6 2.4 5z" />
    <path d="m2.4 8 5.6 2.6L13.6 8" />
    <path d="m2.4 11 5.6 2.6 5.6-2.6" />
  </Svg>
)

/** Reasoning (a lightbulb). */
export const IconThought = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.9 11.2c0-1.1-.4-1.6-1.1-2.5a4 4 0 1 1 6.4 0c-.7.9-1.1 1.4-1.1 2.5" />
    <path d="M6.2 13.4h3.6" />
  </Svg>
)

/** A plan or checklist. */
export const IconPlan = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2.6 4.2 1 1 1.8-1.9" />
    <path d="m2.6 9.2 1 1 1.8-1.9" />
    <path d="M7.6 4.4h5.8M7.6 9.4h5.8M7.6 13h3.8" />
  </Svg>
)

/** Harness bookkeeping and system lines (an "i" in a circle). */
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.4v3.4M8 5.1v.1" />
  </Svg>
)

/** A notice that something needs attention (a triangle with a mark). */
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6 14 13H2Z" />
    <path d="M8 6.6v2.8M8 11.1v.1" />
  </Svg>
)

/** Something failed (a circle with a mark). */
export const IconError = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 5v3.4M8 10.9v.1" />
  </Svg>
)

/** Something went through (a circle with a tick). */
export const IconSuccess = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M5.6 8.2 7.3 9.9 10.5 6.4" />
  </Svg>
)

/** A fetch from the web (a globe). */
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.4 8h11.2M8 2.4c1.5 1.6 2.2 3.5 2.2 5.6S9.5 12 8 13.6C6.5 12 5.8 10.1 5.8 8S6.5 4 8 2.4" />
  </Svg>
)

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3" width="11.2" height="10" rx="2" />
    <circle cx="6" cy="6.6" r="1.1" />
    <path d="m2.8 11.6 3.3-3.1 2.4 2.2 1.8-1.6 3 2.6" />
  </Svg>
)

/** A paperclip: attach a picture or a text file. */
export const IconAttach = (p: IconProps) => (
  <Svg {...p}>
    <path d="m13.2 7.6-5.1 5.1a3.2 3.2 0 0 1-4.5-4.5l5.4-5.4a2.1 2.1 0 0 1 3 3l-5.3 5.3a1 1 0 0 1-1.5-1.5l4.8-4.8" />
  </Svg>
)

/** A text document: a page with lines on it. */
export const IconDocument = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.2 1.9H4.6a1.5 1.5 0 0 0-1.5 1.5v9.2a1.5 1.5 0 0 0 1.5 1.5h6.8a1.5 1.5 0 0 0 1.5-1.5V5.6Z" />
    <path d="M9.2 1.9v3.7h3.7M5.6 8.6h4.8M5.6 11h3.2" />
  </Svg>
)

/** A chip: which model runs the session. */
export const IconModel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.6" />
    <path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2" />
  </Svg>
)

/** A brain: how hard the model thinks (reasoning effort). Lucide's outline, on its 24px grid. */
export const IconBrain = (p: IconProps) => (
  <Svg viewBox="0 0 24 24" strokeWidth={2.1} {...p}>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </Svg>
)

/** A shield: what tools may do without asking (approvals). */
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.9 3 3.8v3.9c0 3 2.1 5.2 5 6.4 2.9-1.2 5-3.4 5-6.4V3.8Z" />
    <path d="m5.9 8 1.5 1.5 2.8-2.9" />
  </Svg>
)

/** A close cross, drawn to the exact centre of the 16px grid. */
/**
 * An arrow rising out of a tray: bring sessions *into* sedano. Drawn upwards on
 * purpose — the downward tray is the universal "download", which is export.
 */
export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 9.7v-7M5.2 5.4 8 2.6l2.8 2.8" />
    <path d="M2.8 9.6v2.3c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4V9.6" />
  </Svg>
)

/** An arrow coming down into a tray: save something out as a file. */
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6v7M5.2 6.9 8 9.7l2.8-2.8" />
    <path d="M2.8 9.6v2.3c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4V9.6" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
  </Svg>
)

/**
 * An up chevron, raised ~1px above the geometric centre: a chevron's weight is
 * in its arms, so the centred one reads as sitting low.
 */
export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.4 8 5.4l4 4" />
  </Svg>
)
