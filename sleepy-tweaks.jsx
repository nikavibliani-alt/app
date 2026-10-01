// Sleepy PMS — Tweaks panel
// Reads defaults from #tweak-defaults JSON, applies as data-attrs on <body>,
// persists via __edit_mode_set_keys.

(() => {
  const defaultsEl = document.getElementById('tweak-defaults');
  let DEFAULTS = { accent: 'moss', density: 'comfortable', sidebar: 'full' };
  if (defaultsEl) {
    try {
      const txt = defaultsEl.textContent.replace('/*EDITMODE-BEGIN*/', '').replace('/*EDITMODE-END*/', '');
      DEFAULTS = JSON.parse(txt);
    } catch (e) { /* keep defaults */ }
  }

  // Apply immediately so the page never paints with stale attrs
  Object.entries(DEFAULTS).forEach(([k, v]) => document.body.setAttribute('data-' + k, v));

  function App() {
    const [t, setTweak] = window.useTweaks(DEFAULTS);

    React.useEffect(() => {
      Object.entries(t).forEach(([k, v]) => document.body.setAttribute('data-' + k, v));
    }, [t]);

    return (
      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Accent" />
        <window.TweakSelect
          label="Brand color"
          value={t.accent}
          onChange={(v) => setTweak('accent', v)}
          options={[
            { value: 'moss',       label: 'Moss (default)' },
            { value: 'indigo',     label: 'Indigo' },
            { value: 'terracotta', label: 'Terracotta' },
            { value: 'navy',       label: 'Navy' },
          ]}
        />

        <window.TweakSection label="Layout" />
        <window.TweakRadio
          label="Density"
          value={t.density}
          onChange={(v) => setTweak('density', v)}
          options={[
            { value: 'dense',       label: 'Dense' },
            { value: 'comfortable', label: 'Comfy' },
            { value: 'spacious',    label: 'Spaced' },
          ]}
        />
        <window.TweakRadio
          label="Sidebar"
          value={t.sidebar}
          onChange={(v) => setTweak('sidebar', v)}
          options={[
            { value: 'full', label: 'Full' },
            { value: 'rail', label: 'Rail' },
          ]}
        />
      </window.TweaksPanel>
    );
  }

  const root = ReactDOM.createRoot(document.getElementById('tweaks-root'));
  root.render(<App />);
})();
