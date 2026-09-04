import type {
  DitheringMode,
  OutputFps,
  PaletteSize,
} from "@/types/conversion"

interface SelectOption<T extends string | number> {
  value: T
  label: string
  description: string
}

export const FPS_OPTIONS: readonly SelectOption<OutputFps>[] = [
  { value: 4, label: "4 FPS", description: "Smallest files; motion can look stepped." },
  { value: 12, label: "12 FPS", description: "Efficient motion for simpler banner animation." },
  { value: 15, label: "15 FPS", description: "Balanced motion quality and file size." },
  { value: 24, label: "24 FPS", description: "Smoothest motion; usually the largest output." },
]

export const PALETTE_OPTIONS: readonly SelectOption<PaletteSize>[] = [
  { value: 64, label: "64 colors", description: "Smallest palette; best for flat, limited-color artwork." },
  { value: 128, label: "128 colors", description: "Compact output with moderate gradient detail." },
  { value: 192, label: "192 colors", description: "Good detail with some file-size savings." },
  { value: 256, label: "256 colors", description: "Maximum GIF color detail; usually the largest output." },
]

export const DITHERING_OPTIONS: readonly SelectOption<DitheringMode>[] = [
  {
    value: "adaptive",
    label: "Adaptive",
    description: "Best balance: compares all methods and chooses the smallest visually equivalent result. Slowest option.",
  },
  {
    value: "none",
    label: "None",
    description: "Usually smallest and crispest for flat artwork, but gradients may show visible bands.",
  },
  {
    value: "bayer-5",
    label: "Light Bayer",
    description: "Subtle ordered texture reduces banding with a modest size increase. Recommended manual choice.",
  },
  {
    value: "bayer-4",
    label: "Bayer",
    description: "Stronger gradient smoothing with more visible texture and typically larger files.",
  },
  {
    value: "gradfun-bayer-5",
    label: "Deband + Light Bayer",
    description: "Smoothest gradients, but may soften fine detail and is usually the largest option.",
  },
]

export function findOption<T extends string | number>(
  options: readonly SelectOption<T>[],
  value: T,
) {
  return options.find((option) => option.value === value)
}
