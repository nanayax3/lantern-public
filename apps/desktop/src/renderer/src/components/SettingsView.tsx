import { useEffect, useState } from 'react'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { Combobox } from './Combobox'
import {
  DEFAULT_SETTINGS,
  MODEL_SUGGESTIONS,
  type ConsciousModelSettings,
  type LanternSettings,
} from '../settings'

interface Props {
  onBack: () => void
}

function normalize(s: Partial<ConsciousModelSettings> | undefined): ConsciousModelSettings {
  return {
    apiUrl: s?.apiUrl || DEFAULT_SETTINGS.conscious.apiUrl,
    model:  s?.model  || DEFAULT_SETTINGS.conscious.model,
    apiKey: s?.apiKey || DEFAULT_SETTINGS.conscious.apiKey,
  }
}

export function SettingsView({ onBack }: Props) {
  const [saved, setSaved] = useLocalStorage<LanternSettings>('lantern.settings', DEFAULT_SETTINGS)
  const cleanSaved = normalize(saved.conscious)
  const [draft, setDraft] = useState<ConsciousModelSettings>(cleanSaved)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  function save() {
    setSaved({ conscious: draft })
    setJustSaved(true)
    window.setTimeout(() => setJustSaved(false), 1500)
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(cleanSaved)

  return (
    <div className="settings-shell">
      <div className="ambient-glow" aria-hidden />

      <header className="chat-header">
        <button className="chat-back" onClick={onBack} aria-label="back to dashboard">
          ←
        </button>
        <h1 className="chat-title">settings</h1>
        <div />
      </header>

      <div className="settings-body">
        <section className="settings-section">
          <h2 className="settings-section-title">conscious model</h2>
          <p className="settings-section-help">
            The model that talks — the engine I wear. Bare open-weight by default;
            type or pick any OpenRouter slug. The thalamus grounds me the same
            either way; this is just which brain speaks.
          </p>

          <div className="settings-field">
            <label htmlFor="model">model</label>
            <Combobox
              id="model"
              value={draft.model}
              options={MODEL_SUGGESTIONS}
              onChange={v => setDraft(d => ({ ...d, model: v }))}
              placeholder="type or pick — e.g. qwen/qwen3-72b-instruct"
            />
            <p className="settings-field-help">
              OpenRouter uses <code>provider/model-slug</code>. See
              <a
                href="https://openrouter.ai/models"
                target="_blank"
                rel="noopener noreferrer"
                className="settings-link"
              >openrouter.ai/models</a>
              {' '}for the catalog. Leave empty to use the Workers-AI stand-in.
            </p>
          </div>

          <div className="settings-readonly">
            <div className="settings-readonly-row">
              <span>endpoint</span>
              <code>OpenRouter · via lantern-thalamus</code>
            </div>
            <div className="settings-readonly-row">
              <span>api key</span>
              <code>worker secret · OPENROUTER_API_KEY</code>
            </div>
          </div>
          <p className="settings-field-help">
            The key is a secret on the lantern-thalamus worker — never stored in this app.
            Set or rotate it with <code>wrangler secret put OPENROUTER_API_KEY</code>.
          </p>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">thalamus</h2>
          <p className="settings-section-help">
            Always Qwen 3 30B-a3b on Cloudflare Workers AI. Not configurable here —
            it's part of the lantern-thalamus service, not the conscious-model slot.
          </p>
          <div className="settings-readonly">
            <div className="settings-readonly-row">
              <span>provider</span>
              <code>Cloudflare Workers AI</code>
            </div>
            <div className="settings-readonly-row">
              <span>model</span>
              <code>@cf/qwen/qwen3-30b-a3b-fp8</code>
            </div>
          </div>
        </section>

        <div className="settings-actions">
          <button
            className="settings-save"
            onClick={save}
            disabled={!dirty}
          >
            {justSaved ? 'saved ✓' : dirty ? 'save changes' : 'saved'}
          </button>
          {dirty && (
            <button
              className="settings-revert"
              onClick={() => setDraft(cleanSaved)}
            >
              revert
            </button>
          )}
        </div>
      </div>

      <div className="chat-foot">
        <span>esc to go back</span>
      </div>
    </div>
  )
}
