import { TimerReset } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DITHERING_OPTIONS,
  findOption,
  FPS_OPTIONS,
  PALETTE_OPTIONS,
} from "@/lib/export-options"
import type {
  ConversionFormConfig,
  ConversionFormConfigValidity,
  DitheringMode,
  LoopMode,
  OutputFps,
  PaletteSize,
} from "@/types/conversion"

interface ConfigPanelProps {
  config: ConversionFormConfig
  validity: ConversionFormConfigValidity
  disabled: boolean
  onChange: (config: ConversionFormConfig) => void
}

const FPS_SELECT_ITEMS = FPS_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))
const PALETTE_SELECT_ITEMS = PALETTE_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))
const DITHERING_SELECT_ITEMS = DITHERING_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
const LOOP_SELECT_ITEMS = [
  { value: "auto", label: "Auto-detect" },
  { value: "once", label: "Play once" },
  { value: "infinite", label: "Loop forever" },
]

export function ConfigPanel({ config, validity, disabled, onChange }: ConfigPanelProps) {
  const selectedFps = findOption(FPS_OPTIONS, config.outputFps)
  const selectedPalette = findOption(PALETTE_OPTIONS, config.maxColors)
  const selectedDithering = findOption(DITHERING_OPTIONS, config.dithering)
  const gifskiQualityDescriptionIds = validity.gifskiQuality
    ? "gifski-quality-description"
    : "gifski-quality-description gifski-quality-error"
  const durationDescriptionIds = validity.maxDurationSeconds
    ? "max-duration-description"
    : "max-duration-description max-duration-error"

  function updateDuration(value: string) {
    const numericValue = value.trim() === "" ? 0 : Number(value)
    onChange({
      ...config,
      maxDurationSeconds: Number.isFinite(numericValue) ? numericValue : 0,
    })
  }

  function updateGifskiQuality(value: string) {
    const numericValue = value.trim() === "" ? 0 : Number(value)
    onChange({
      ...config,
      gifskiQuality: Number.isFinite(numericValue) ? numericValue : 0,
    })
  }

  return (
    <Card className="config-card">
      <CardHeader>
        <CardTitle>Forge settings</CardTitle>
        <CardDescription>Control motion, color, dithering, and compression independently.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="config-fields">
          <Field data-invalid={!validity.outputFps || undefined} data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="output-fps">Frame rate</FieldLabel>
            <Select
              items={FPS_SELECT_ITEMS}
              value={String(config.outputFps)}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, outputFps: Number(value) as OutputFps })}
            >
              <SelectTrigger id="output-fps" className="config-select" aria-describedby="output-fps-description">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FPS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription id="output-fps-description">{selectedFps?.description}</FieldDescription>
          </Field>

          <Field data-invalid={!validity.maxColors || undefined} data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="max-colors">Color palette</FieldLabel>
            <Select
              items={PALETTE_SELECT_ITEMS}
              value={String(config.maxColors)}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, maxColors: Number(value) as PaletteSize })}
            >
              <SelectTrigger id="max-colors" className="config-select" aria-describedby="max-colors-description">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PALETTE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription id="max-colors-description">{selectedPalette?.description}</FieldDescription>
          </Field>

          <Field
            className="config-wide"
            data-disabled={disabled || undefined}
          >
            <FieldLabel htmlFor="dithering">Dithering</FieldLabel>
            <Select
              items={DITHERING_SELECT_ITEMS}
              value={config.dithering}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, dithering: value as DitheringMode })}
            >
              <SelectTrigger id="dithering" className="config-select" aria-describedby="dithering-description">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {DITHERING_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription id="dithering-description" aria-live="polite">{selectedDithering?.description}</FieldDescription>
          </Field>

          <Field
            className="config-wide"
            data-invalid={!validity.gifskiQuality || undefined}
            data-disabled={disabled || undefined}
          >
            <FieldLabel htmlFor="gifski-quality">Gifski quality</FieldLabel>
            <div className="unit-input">
              <Input
                id="gifski-quality"
                type="number"
                min="1"
                max="100"
                step="1"
                inputMode="numeric"
                disabled={disabled}
                value={config.gifskiQuality}
                aria-invalid={!validity.gifskiQuality}
                aria-describedby={gifskiQualityDescriptionIds}
                onChange={(event) => updateGifskiQuality(event.target.value)}
              />
              <span aria-hidden="true">%</span>
            </div>
            <FieldDescription id="gifski-quality-description">
              Quality score, not a size target. Lower values compress more; 100 disables lossy compression.
            </FieldDescription>
            {!validity.gifskiQuality ? (
              <FieldError id="gifski-quality-error">Enter a whole number from 1–100.</FieldError>
            ) : null}
          </Field>

          <Field data-invalid={!validity.maxDurationSeconds || undefined} data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="max-duration">Max duration</FieldLabel>
            <div className="unit-input">
              <TimerReset aria-hidden="true" />
              <Input
                id="max-duration"
                type="number"
                min="0.1"
                max="60"
                step="0.1"
                disabled={disabled}
                value={config.maxDurationSeconds}
                aria-invalid={!validity.maxDurationSeconds}
                aria-describedby={durationDescriptionIds}
                onChange={(event) => updateDuration(event.target.value)}
              />
              <span aria-hidden="true">sec</span>
            </div>
            <FieldDescription id="max-duration-description">Capture limit, in seconds</FieldDescription>
            {!validity.maxDurationSeconds ? (
              <FieldError id="max-duration-error">Enter a duration from 0.1–60 seconds.</FieldError>
            ) : null}
          </Field>

          <Field className="loop-field" data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="loop-mode">Playback loop</FieldLabel>
            <Select
              items={LOOP_SELECT_ITEMS}
              value={config.loopMode}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, loopMode: value as LoopMode })}
            >
              <SelectTrigger id="loop-mode" className="config-select" aria-describedby="loop-mode-description">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  <SelectItem value="once">Play once</SelectItem>
                  <SelectItem value="infinite">Loop forever</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription id="loop-mode-description">Auto follows source behavior.</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
