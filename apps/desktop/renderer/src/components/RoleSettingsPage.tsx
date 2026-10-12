import { useEffect, useState } from 'react';
import { Copy, Play, Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../api';
import { proactiveState } from '../../../observation.mjs';
import type { Bootstrap, Companion, CompanionMode } from '../types';
import { PersonaPage } from './SettingsPages';
import { WorkflowsPage } from './ManagementPages';
import { Field, IconButton, PageHeader, Row, SaveButton, Toggle } from './Ui';

type Action = (operation: () => Promise<unknown>, message?: string) => Promise<void>;
interface Props {
  data: Bootstrap; action: Action; reload: () => Promise<void>;
  save: (value: Companion) => Promise<void>; trial: (text: string) => Promise<void>;
  runWorkflow: (id: string, mode: string) => Promise<void>;
}
const templates = [
  { name: '日常闲聊', prompt: '自然地交流日常，尊重我的情绪和个人边界。', screenAllowed: false },
  { name: '工作陪聊', prompt: '关注当前工作，建议简短可执行，不要频繁打断。', screenAllowed: false },
  { name: '游戏陪玩', prompt: '结合画面给出简短明确的游戏建议，不确定时说明。', screenAllowed: true },
  { name: '电影陪看', prompt: '只讨论已看到的剧情，不剧透，没有新内容时保持安静。', screenAllowed: true },
];
function newMode(): CompanionMode {
  return { id: crypto.randomUUID(), name: '新模式', prompt: '', screenAllowed: false, proactive: false,
    cooldown: 180, hourlyLimit: 20, quietStart: '23:00', quietEnd: '08:00', replyLength: 'inherit',
    observation: { periodic: false, onChange: false, interval: 30, changeThreshold: .12 } };
}

export function RoleSettingsPage(props: Props) {
  const { data } = props;
  const [selected, setSelected] = useState('base');
  const [creating, setCreating] = useState<{ value: CompanionMode; appearance: string } | null>(null);
  const tabs = [...data.modes, ...(creating ? [creating.value] : [])];
  return <div className="role-settings-page">
    <div className="tabs role-setting-tabs" role="tablist" aria-label="角色设定切页" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    }}>
      <button role="tab" tabIndex={selected === 'base' ? 0 : -1} aria-selected={selected === 'base'} className={selected === 'base' ? 'selected' : ''} onClick={() => setSelected('base')}>基础设定</button>
      {tabs.map((mode) => <button role="tab" tabIndex={selected === mode.id ? 0 : -1} key={mode.id} aria-selected={selected === mode.id} className={selected === mode.id ? 'selected' : ''} onClick={() => setSelected(mode.id)}>{mode.name}{mode.id === data.settings.companion.mode && <span className="status-dot" />}</button>)}
      <IconButton title="新建模式" disabled={data.modes.length >= 50} onClick={() => {
        const draft = creating || { value: newMode(), appearance: '' };
        setCreating(draft); setSelected(draft.value.id);
      }}><Plus size={18} /></IconButton>
    </div>
    <div role="tabpanel" hidden={selected !== 'base'}><PersonaPage value={data.settings.persona} previewUrl={data.roles.find((role) => role.id === data.activeRoleId)?.previewUrl} action={props.action} reload={props.reload} /></div>
    {tabs.map((mode) => <div role="tabpanel" hidden={selected !== mode.id} key={mode.id}>
      <ModeEditor {...props} value={mode} initialAppearance={creating?.value.id === mode.id ? creating.appearance : data.settings.companion.modeAppearances[mode.id] || ''}
        onSaved={() => { if (creating?.value.id === mode.id) setCreating(null); }}
        onCopy={(value, appearance) => { const copy = { ...value, id: crypto.randomUUID(), name: value.name + ' 副本' }; if (creating && !confirm('替换尚未保存的新模式？')) return; setCreating({ value: copy, appearance }); setSelected(copy.id); }}
        onDeleted={() => { setCreating(null); setSelected('base'); }} />
    </div>)}
  </div>;
}

function ModeEditor({ value, initialAppearance, onSaved, onCopy, onDeleted, ...props }: Props & {
  value: CompanionMode; initialAppearance: string; onSaved: () => void;
  onCopy: (mode: CompanionMode, appearance: string) => void; onDeleted: () => void;
}) {
  const { data, action, reload, save, trial, runWorkflow } = props;
  const [draft, setDraft] = useState(value);
  const [appearance, setAppearance] = useState(initialAppearance);
  const [tab, setTab] = useState<'settings' | 'proactive' | 'workflows'>('settings');
  const [text, setText] = useState('');
  const [testing, setTesting] = useState(false);
  const signature = JSON.stringify(value);
  useEffect(() => setDraft(value), [signature]);
  useEffect(() => setAppearance(initialAppearance), [initialAppearance]);
  const saved = data.modes.some((mode) => mode.id === value.id);
  const patch = (change: Partial<CompanionMode>) => setDraft((old) => ({ ...old, ...change }));
  const observation = (change: Partial<CompanionMode['observation']>) => patch({ observation: { ...draft.observation, ...change } });
  const persist = async () => {
    if (!draft.name.trim()) throw Error('请填写模式名称');
    const latest = await api<Bootstrap>('/api/bootstrap');
    const modes = latest.modes.some((mode) => mode.id === draft.id) ? latest.modes.map((mode) => mode.id === draft.id ? draft : mode) : [...latest.modes, draft];
    await api('/api/modes', 'PUT', modes);
    const current = (await api<Bootstrap>('/api/bootstrap')).settings.companion;
    await save({ ...current, modeAppearances: { ...current.modeAppearances, [draft.id]: appearance } });
    await reload(); onSaved();
  };
  const state = proactiveState(data.desktop, data.settings.companion, value);
  return <div className="management-page mode-detail-page">
    <PageHeader title={draft.name} subtitle="陪伴模式">
      {data.settings.companion.mode === draft.id ? <span className="badge teal">当前陪伴</span> : saved && <button className="secondary" onClick={() => action(async () => { await save({ ...(await api<Bootstrap>('/api/bootstrap')).settings.companion, mode: draft.id }); await reload(); }, '当前陪伴模式已切换')}><Play size={15} />使用此模式</button>}
      <IconButton title={'复制模式 ' + draft.name} disabled={data.modes.length >= 50} onClick={() => onCopy(draft, appearance)}><Copy size={16} /></IconButton>
      <IconButton title={'删除模式 ' + draft.name} disabled={saved && data.modes.length === 1} onClick={() => action(async () => {
        if (!confirm('删除「' + draft.name + '」？')) return;
        if (saved) { await api('/api/modes', 'PUT', (await api<Bootstrap>('/api/bootstrap')).modes.filter((mode) => mode.id !== draft.id)); await reload(); }
        onDeleted();
      })}><Trash2 size={16} /></IconButton>
      {tab !== 'workflows' && <SaveButton onClick={() => action(persist, '模式已保存')} />}
    </PageHeader>
    <div className="tabs mode-detail-tabs"><button className={tab === 'settings' ? 'selected' : ''} onClick={() => setTab('settings')}>模式设定</button><button className={tab === 'proactive' ? 'selected' : ''} onClick={() => setTab('proactive')}>主动互动</button><button className={tab === 'workflows' ? 'selected' : ''} disabled={!saved} onClick={() => setTab('workflows')}>工作流</button></div>
    <div hidden={tab !== 'settings'} className="mode-editor"><div>
      {!saved && <Field label="模式模板"><select defaultValue="" onChange={(e) => { const template = templates.find((item) => item.name === e.target.value); if (template) patch(template); }}><option value="">自定义</option>{templates.map((item) => <option key={item.name}>{item.name}</option>)}</select></Field>}
      <Field label="模式名称"><input value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
      <Field label="场景提示词"><textarea rows={8} value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} /></Field>
      <Field label="默认形象"><select value={appearance} onChange={(e) => setAppearance(e.target.value)}><option value="">保持当前形象</option>{data.appearances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="回复长度"><select value={draft.replyLength} onChange={(e) => patch({ replyLength: e.target.value as CompanionMode['replyLength'] })}><option value="inherit">使用角色默认</option><option value="short">简短</option><option value="medium">适中</option><option value="long">详细</option></select></Field>
      <Row label="允许屏幕感知"><Toggle label="模式允许屏幕感知" checked={draft.screenAllowed} onChange={(v) => patch({ screenAllowed: v })} /></Row>
    </div><section className="mode-trial"><header>试聊 <span className="badge">保存并使用此模式</span></header><div className="messages">{data.messages.slice(-6).map((m) => <article className={'message ' + m.role} key={m.id}><div className="message-meta">{m.role === 'user' ? '你' : data.settings.persona.characterName}</div><p>{m.content}</p></article>)}</div><div className="trial-composer"><input aria-label="试聊输入" value={text} onChange={(e) => setText(e.target.value)} /><IconButton title="发送试聊" disabled={!text.trim() || testing} onClick={() => action(async () => { setTesting(true); try { await persist(); await save({ ...(await api<Bootstrap>('/api/bootstrap')).settings.companion, mode: draft.id }); await trial(text); setText(''); } finally { setTesting(false); } })}><Send size={17} /></IconButton></div></section></div>
    <div hidden={tab !== 'proactive'} className="mode-automation">
      <Row label="主动发言"><Toggle label="模式主动发言" checked={draft.proactive} onChange={(v) => patch({ proactive: v })} /></Row>
      <Row label="实际状态"><span className={'badge ' + (state.allowed && data.settings.companion.mode === draft.id ? 'teal' : '')}>{!saved ? '模式尚未保存' : data.settings.companion.mode !== draft.id ? '当前未使用此模式' : state.reason || '自动观察已就绪'}</span></Row>
      <h2 className="section-title">自动观察触发</h2>
      <Row label="定期观察"><Toggle label="模式定期观察" checked={draft.observation.periodic} onChange={(v) => observation({ periodic: v })} /></Row>
      <Row label="画面变化时"><Toggle label="模式画面变化时" checked={draft.observation.onChange} onChange={(v) => observation({ onChange: v })} /></Row>
      {(draft.observation.periodic || draft.observation.onChange) && <Field label="观察间隔（秒）"><input type="number" min="5" max="3600" value={draft.observation.interval} onChange={(e) => observation({ interval: +e.target.value })} /></Field>}
      {draft.observation.onChange && <Field label={`变化阈值 · ${Math.round(draft.observation.changeThreshold * 100)}%`}><input type="range" min=".01" max="1" step=".01" value={draft.observation.changeThreshold} onChange={(e) => observation({ changeThreshold: +e.target.value })} /></Field>}
      <h2 className="section-title">发言限制</h2>
      <div className="form-grid"><Field label="冷却时间（秒）"><input type="number" min="10" max="7200" value={draft.cooldown} onChange={(e) => patch({ cooldown: +e.target.value })} /></Field><Field label="每小时主动上限"><input type="number" min="1" max="200" value={draft.hourlyLimit} onChange={(e) => patch({ hourlyLimit: +e.target.value })} /></Field><Field label="安静开始"><input type="time" value={draft.quietStart} onChange={(e) => patch({ quietStart: e.target.value })} /></Field><Field label="安静结束"><input type="time" value={draft.quietEnd} onChange={(e) => patch({ quietEnd: e.target.value })} /></Field></div>
    </div>
    {saved && <div hidden={tab !== 'workflows'}><WorkflowsPage items={data.workflows} modes={data.modes} modeId={draft.id} action={action} reload={reload} automaticSettings={() => setTab('proactive')} run={(id) => runWorkflow(id, draft.id)} /></div>}
  </div>;
}
