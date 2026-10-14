import { t } from '../i18n';
import type { ReactNode } from 'react';
import { Brain, Eye, Library, Volume2 } from 'lucide-react';
import type { ConfigurationTab } from '../types';

const sections = [
  { id: 'llm', name: '思维', icon: Brain },
  { id: 'tts', name: '声音', icon: Volume2 },
  { id: 'vision', name: '视觉', icon: Eye },
  { id: 'memory', name: '记忆', icon: Library },
] as const;

export function ConfigurationPage({ tab, setTab, children }: { tab: ConfigurationTab; setTab: (tab: ConfigurationTab) => void; children: ReactNode }) {
  return <div className="role-configuration">
    <div className="tabs configuration-tabs" role="tablist" aria-label={t("角色配置")}>
      {sections.map(({ id, name, icon: Icon }, index) => <button key={id} id={'config-tab-' + id} role="tab" aria-selected={tab === id} aria-controls="configuration-content" tabIndex={tab === id ? 0 : -1} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(sections[next].id);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('#config-tab-' + sections[next].id)?.focus();
      }}><Icon size={16} />{t(name)}</button>)}
    </div>
    <section id="configuration-content" role="tabpanel" aria-labelledby={'config-tab-' + tab} key={tab === 'llm' || tab === 'tts' ? 'providers' : tab}>{children}</section>
  </div>;
}
