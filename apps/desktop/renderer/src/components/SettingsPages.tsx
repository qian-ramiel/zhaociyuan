import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { providerNumberError } from '../../../errors.mjs';
import { normalizeTtsSettings } from '../../../tts.mjs';
import { screenState } from '../../../observation.mjs';
import { Check, Download, Eye, KeyRound, LoaderCircle, Mic, Monitor, Play, RefreshCw, Upload, UserRound, Volume2, X } from 'lucide-react';
import { api, downloadJson, upload } from '../api';
import type { Companion, CompanionMode, DesktopPreferences, ModelService, Persona, Providers, ScreenContext, Source, ServiceProfile } from '../types';
import { Field, IconButton, Modal, PageHeader, Row, SaveButton, Toggle } from './Ui';

type Action = (operation: () => Promise<unknown>, message?: string) => Promise<void>;

export function PersonaPage({ value, previewUrl, action, reload }: { value: Persona; previewUrl?: string | null; action: Action; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
  const fields: [keyof Persona, string][] = [['personality', t("人设")], ['relationship', t("关系")], ['speakingStyle', t("说话风格")], ['boundaries', t("互动边界")], ['exampleDialogue', t("示例对话")]];
  return <div className="settings-page persona-page"><PageHeader title={value.characterName} subtitle={t("角色设定")}><SaveButton onClick={() => action(async () => { await api('/api/settings/persona', 'PUT', draft); await reload(); }, t("角色设定已保存"))} /></PageHeader>
    <div className="persona-identity">{previewUrl ? <img src={previewUrl} alt={value.characterName} /> : <div className="persona-avatar-empty"><UserRound size={32} /></div>}<strong>{value.characterName}</strong></div><div className="form-grid"><Field label={t("角色名字")}><input value={draft.characterName} onChange={(e) => setDraft({ ...draft, characterName: e.target.value })} /></Field><Field label={t("称呼你的方式")}><input value={draft.userName} onChange={(e) => setDraft({ ...draft, userName: e.target.value })} /></Field></div>
    {fields.map(([key, label]) => <Field key={key} label={label}><textarea rows={key === 'exampleDialogue' ? 3 : 1} value={String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></Field>)}
    <details className="persona-advanced"><summary>{t("更多设定")}</summary>{([['background', t("角色背景")], ['likes', t("喜欢")], ['dislikes', t("不喜欢")], ['systemPrompt', t("系统提示词")]] as [keyof Persona, string][]).map(([key, label]) => <Field label={label} key={key}><textarea rows={key === 'systemPrompt' ? 6 : 2} value={String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></Field>)}</details>
    <Field label={t("回复长度")}><select value={draft.replyLength} onChange={(e) => setDraft({ ...draft, replyLength: e.target.value })}><option value="short">{t("简短")}</option><option value="medium">{t("适中")}</option><option value="long">{t("详细")}</option></select></Field>
  </div>;
}

function ModelFields({ value, onChange }: { value: ModelService; onChange: (value: ModelService) => void }) {
  return <><Field label={t("API 地址")}><input placeholder="https://example.com/v1" value={value.baseUrl} onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} /></Field>
    <Field label="API Key"><input type="password" autoComplete="off" placeholder={value.hasApiKey ? t("已保存，留空保留原密钥") : t("本地服务可留空")} value={value.apiKey} onChange={(e) => onChange({ ...value, apiKey: e.target.value })} /></Field>
    <Field label={t("模型名称")}><input placeholder={t("服务提供的模型 ID")} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} /></Field>
    <div className="form-grid"><Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={value.temperature} onChange={(e) => onChange({ ...value, temperature: Number(e.target.value) })} /></Field><Field label={t("回复 Token 上限")}><input type="number" min="128" max="32768" value={value.maxTokens} onChange={(e) => onChange({ ...value, maxTokens: Number(e.target.value) })} /></Field></div>
    <Row label={t("服务支持 JSON 模式")}><Toggle checked={value.jsonMode} label={t("JSON 模式")} onChange={(v) => onChange({ ...value, jsonMode: v })} /></Row>
  </>;
}

export function ProvidersPage({ value, action, reload, onAudio, profiles, section, onProfiles }: { value: Providers; profiles: ServiceProfile[]; action: Action; reload: () => Promise<void>; onAudio: (url: string) => Promise<void>; section?: 'llm' | 'tts' | 'vision'; onProfiles?: () => void }) {
  const [draft, setDraft] = useState(() => ({ ...value, tts: normalizeTtsSettings(value.tts) }));
  const [naming, setNaming] = useState(false);
  const [profileName, setProfileName] = useState('');
  useEffect(() => setDraft({ ...value, tts: normalizeTtsSettings(value.tts) }), [value]);
  const [tab, setTab] = useState<'llm' | 'vision' | 'tts' | 'asr' | 'image'>(section || 'llm');
  useEffect(() => { if (section) setTab(section); }, [section]);
  const [other, setOther] = useState<'vision' | 'asr' | 'image'>('vision');
  const [imagePreview, setImagePreview] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');
  const [validation, setValidation] = useState<ReturnType<typeof providerNumberError>>(null);
  const requestVersion = useRef(0);
  const recordingEpoch = useRef(0);
  const testRecorder = useRef<MediaRecorder | null>(null);
  const testStream = useRef<MediaStream | null>(null);
  const stopTestRecording = () => {
    recordingEpoch.current++;
    if (testRecorder.current?.state === 'recording') testRecorder.current.stop();
    testStream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  };
  useEffect(() => { if (tab !== 'asr') stopTestRecording(); }, [tab]);
  useEffect(() => {
    const unsubscribe = window.desktop?.onState((state) => {
      if (state.desktopPreferences?.hearingEnabled === false) stopTestRecording();
    });
    return () => { requestVersion.current++; stopTestRecording(); unsubscribe?.(); };
  }, []);
  const testRecording = () => action(async () => {
    const preferences = await api<DesktopPreferences>('/api/desktop');
    if (!preferences.hearingEnabled) throw new Error(t("听觉已关闭，请打开听觉开关后重试"));
    const epoch = ++recordingEpoch.current;
    setRecording(true);
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (epoch !== recordingEpoch.current || !(await api<DesktopPreferences>('/api/desktop')).hearingEnabled) return;
      testStream.current = stream;
      recorder = new MediaRecorder(stream);
      testRecorder.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise<Blob>((resolve) => {
        recorder!.onstop = () => resolve(new Blob(chunks, { type: recorder!.mimeType }));
      });
      recorder.start();
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 4000)), stopped]);
      if (recorder.state === 'recording') recorder.stop();
      const blob = await stopped;
      if (epoch !== recordingEpoch.current) return;
      const result = await upload<{ text: string }>('/api/asr/transcribe', blob, 'test.webm');
      if (epoch === recordingEpoch.current) setTranscript(result.text);
    } finally {
      if (recorder?.state === 'recording') recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      if (testStream.current === stream) { testStream.current = null; testRecorder.current = null; }
      if (epoch === recordingEpoch.current) setRecording(false);
    }
  });
  const pageElement = useRef<HTMLDivElement>(null);
  const validate = () => {
    const error = providerNumberError(draft);
    if (!error) { setValidation(null); return; }
    const message = t(error.messageKey, { v0: t(error.label) });
    setValidation(error);
    const kind = error.kind;
    if (kind === 'vision') setOther('vision');
    setTab(kind);
    requestAnimationFrame(() => pageElement.current?.querySelector<HTMLInputElement>(`[aria-label="${t(error.field)}"]`)?.focus());
    throw new Error(message);
  };
  useEffect(() => { requestVersion.current++; setResult(''); setValidation(null); setTesting(false); }, [tab, draft]);
  const test = () => action(async () => {
    validate();
    const version = ++requestVersion.current;
    setTesting(true); setResult('');
    try {
      if (tab === 'tts') { const data = await api<{ audio_url: string }>('/api/providers/tts/test', 'POST', normalizeTtsSettings(draft.tts)); if (version === requestVersion.current) { setResult(t("TTS：语音生成成功")); await onAudio(data.audio_url); } }
      else if (tab === 'llm') { const data = await api<{ message: string }>('/api/providers/llm/test', 'POST', draft.llm); if (version === requestVersion.current) setResult(t("对话模型：") + data.message); }
    } finally { if (version === requestVersion.current) setTesting(false); }
  });
  return <div className="settings-page" ref={pageElement}><PageHeader title={section === 'llm' ? t("思维") : section === 'tts' ? t("声音") : section === 'vision' ? t("视觉模型") : t("模型与声音")} subtitle={section === 'llm' ? 'LLM' : section === 'tts' ? t("TTS 与语音识别") : t("服务配置")}><SaveButton onClick={() => action(async () => { validate(); await api('/api/settings/providers', 'PUT', { ...draft, tts: normalizeTtsSettings(draft.tts) }); await reload(); }, t("服务配置已保存"))} /></PageHeader>
    {!section && <><div className="tabs"><button className={tab === 'llm' ? 'selected' : ''} onClick={() => setTab('llm')}>{t("对话模型")}</button><button className={tab === 'tts' ? 'selected' : ''} onClick={() => setTab('tts')}>TTS</button><button className={!['llm', 'tts'].includes(tab) ? 'selected' : ''} onClick={() => setTab(other)}>{t("其他服务")}</button></div>{!['llm', 'tts'].includes(tab) && <div className="tabs service-subtabs">{(['vision', 'asr', 'image'] as const).map((id) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => { setOther(id); setTab(id); }}>{({ vision: t("视觉"), asr: t("语音识别"), image: t("文生图") })[id]}</button>)}</div>}</>}
    {section === 'tts' && <div className="tabs service-subtabs"><button className={tab === 'tts' ? 'selected' : ''} onClick={() => setTab('tts')}>{t("语音合成")}</button><button className={tab === 'asr' ? 'selected' : ''} onClick={() => setTab('asr')}>{t("语音识别")}</button></div>}
    <div className="provider-presets"><select aria-label={t("载入服务方案")} value="" onChange={(e) => { const profile = profiles.find((p) => p.id === e.target.value); if (profile) setDraft(profile.providers); }}><option value="">{t("从方案库载入")}</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><IconButton title={t("导出服务配置")} onClick={() => { const providers = structuredClone(draft); for (const key of ['llm', 'vision', 'tts', 'image'] as const) { providers[key].apiKey = ''; providers[key].hasApiKey = false; } downloadJson('服务方案.json', { format: 'nice-people-profile', name: t("角色服务方案"), providers }); }}><Download size={16} /></IconButton><label className="icon-button upload-button" title={t("导入服务配置")}><Upload size={16} /><input type="file" accept=".json" onChange={(e) => { const file = e.target.files?.[0]; if (file) void action(async () => { if (file.size > 1024 * 1024) throw new Error(t("配置文件过大")); const value = JSON.parse(await file.text()); if (value.format !== 'nice-people-profile') throw new Error(t("方案格式无效")); const result = await api<{ id: string }>('/api/profiles', 'POST', value); await api('/api/profiles/' + result.id + '/apply', 'POST'); await reload(); }); e.target.value = ''; }} /></label><button className="secondary" onClick={() => setNaming(true)}>{t("保存为方案")}</button>{onProfiles && <button className="text-button" onClick={onProfiles}>{t("管理方案")}</button>}</div>
    {tab === 'llm' && <><Field label={t("接入协议")}><select value={draft.llm.provider} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, provider: e.target.value } })}><option value="compatible">{t("Chat Completions 兼容")}</option></select></Field><ModelFields value={draft.llm} onChange={(llm) => setDraft({ ...draft, llm })} /><Row label={t("流式回复")}><Toggle label={t("流式回复")} checked={draft.llm.streaming !== false} onChange={(v) => setDraft({ ...draft, llm: { ...draft.llm, streaming: v } })} /></Row></>}
    {tab === 'vision' && <><Row label={t("与对话共用模型")}><Toggle label={t("与对话共用模型")} checked={draft.visionUseChat} onChange={(v) => setDraft({ ...draft, visionUseChat: v })} /></Row>{draft.visionUseChat ? <div className="status-note"><Eye size={17} />{t("当前使用对话模型接收图片")}</div> : <ModelFields value={draft.vision} onChange={(vision) => setDraft({ ...draft, vision })} />}</>}
    {tab === 'tts' && <><Field label={t("TTS 服务")}><select value={draft.tts.provider} onChange={(e) => {
      const provider = e.target.value as Providers['tts']['provider'];
      setDraft({ ...draft, tts: { ...draft.tts, provider, ...(provider === 'minimax' ? {
        baseUrl: draft.tts.baseUrl || 'https://api.minimax.cn/v1',
        model: !draft.tts.model || draft.tts.model.startsWith('kokoro-') ? 'speech-2.8-hd' : draft.tts.model,
        voice: !draft.tts.voice || /^(zf|zm)_/.test(draft.tts.voice) ? 'male-qn-qingse' : draft.tts.voice,
      } : {}) } });
    }}><option value="local">{t("本地 Kokoro")}</option><option value="openai">{t("OpenAI 兼容")}</option><option value="custom">{t("自定义 OpenAI 兼容")}</option><option value="minimax">MiniMax（HTTP）</option></select></Field>
      {draft.tts.provider !== 'local' && <><Field label={t("TTS API 地址")}><input placeholder={draft.tts.provider === 'minimax' ? 'https://api.minimax.cn/v1/t2a_v2' : 'https://example.com/v1'} value={draft.tts.baseUrl} onChange={(e) => setDraft({ ...draft, tts: normalizeTtsSettings({ ...draft.tts, baseUrl: e.target.value }) })} /></Field><Field label="TTS API Key"><input type="password" autoComplete="off" placeholder={draft.tts.hasApiKey ? t("已保存，留空保留") : ''} value={draft.tts.apiKey} onChange={(e) => setDraft({ ...draft, tts: { ...draft.tts, apiKey: e.target.value } })} /></Field><Field label={t("TTS 模型")}><input value={draft.tts.model} onChange={(e) => setDraft({ ...draft, tts: { ...draft.tts, model: e.target.value } })} /></Field></>}
      <Field label={t("音色")}>{draft.tts.provider === 'local' ? <select value={draft.tts.voice} onChange={(e) => setDraft({ ...draft, tts: { ...draft.tts, voice: e.target.value } })}>{[['zf_xiaobei', t("小北")], ['zf_xiaoni', t("小妮")], ['zf_xiaoxiao', t("小小")], ['zf_xiaoyi', t("小伊")], ['zm_yunjian', t("云健")], ['zm_yunxi', t("云希")]].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : <input value={draft.tts.voice} onChange={(e) => setDraft({ ...draft, tts: { ...draft.tts, voice: e.target.value } })} />}</Field>
      <Field label={t("语速 · {{v0}}×", { v0: draft.tts.speed.toFixed(1) })}><input type="range" min="0.5" max="1.5" step="0.1" value={draft.tts.speed} onChange={(e) => setDraft({ ...draft, tts: { ...draft.tts, speed: Number(e.target.value) } })} /></Field>
      <h2 className="section-title">{t("回复播放")}</h2><Row label={t("自动朗读文字回复")}><Toggle label={t("自动朗读文字回复")} checked={draft.tts.autoplay} onChange={(v) => setDraft({ ...draft, tts: { ...draft.tts, autoplay: v } })} /></Row>
      {draft.tts.provider !== 'local' && <Row label={t("流式语音")}><Toggle label={t("流式语音")} checked={draft.tts.streaming !== false} onChange={(v) => setDraft({ ...draft, tts: { ...draft.tts, streaming: v } })} /></Row>}
    </>}
    {tab === 'asr' && <><div className="status-note">{t("本地 SenseVoice")}</div><Field label={t("识别语言")}><select value={draft.asr.language} onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, language: e.target.value } })}><option value="auto">{t("自动")}</option><option value="zh">{t("中文")}</option><option value="en">{t("英语")}</option><option value="ja">{t("日语")}</option><option value="ko">{t("韩语")}</option><option value="yue">{t("粤语")}</option></select></Field><button className="secondary" disabled={recording} onClick={testRecording}><Mic size={16} />{recording ? t("正在录音…") : t("测试录音（4 秒）")}</button>{transcript && <div className="status-note">{transcript}</div>}<h2 className="section-title">{t("语音输入发送方式")}</h2><Field label={t("录音结束后")}><select value={draft.asr.autoSend ? "auto" : "manual"} onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, autoSend: e.target.value === "auto" } })}><option value="manual">{t("填入聊天框，手动发送")}</option><option value="auto">{t("自动发送")}</option></select></Field><Field label={t("断句静音时长（秒）")}><input type="number" min="0.5" max="3" step="0.1" value={draft.asr.silenceSeconds} onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, silenceSeconds: Number(e.target.value) } })} /></Field></>}
    {tab === 'image' && <><Field label={t("生成模式")}><select value={draft.image.mode} onChange={(e) => setDraft({ ...draft, image: { ...draft.image, mode: e.target.value as Providers['image']['mode'] } })}><option value="off">{t("关闭")}</option><option value="manual">{t("手动")}</option><option value="suggest">{t("建议后确认")}</option><option value="auto">{t("自动")}</option></select></Field>{(['baseUrl', 'apiKey', 'model', 'style'] as const).map((key) => <Field key={key} label={({ baseUrl: t("图片 API 地址"), apiKey: t("图片 API Key"), model: t("图片模型"), style: '默认风格' })[key]}><input type={key === 'apiKey' ? 'password' : 'text'} value={draft.image[key]} placeholder={key === 'apiKey' && draft.image.hasApiKey ? t("已保存，留空保留") : ''} onChange={(e) => setDraft({ ...draft, image: { ...draft.image, [key]: e.target.value } })} /></Field>)}<Field label={t("图片尺寸")}><select value={draft.image.size} onChange={(e) => setDraft({ ...draft, image: { ...draft.image, size: e.target.value } })}><option>1024x1024</option><option>1024x1536</option><option>1536x1024</option></select></Field><div className="form-grid"><Field label={t("生成冷却（秒）")}><input type="number" min="0" max="7200" value={draft.image.cooldown ?? 120} onChange={(e) => setDraft({ ...draft, image: { ...draft.image, cooldown: +e.target.value } })} /></Field><Field label={t("每小时上限")}><input type="number" min="1" max="100" value={draft.image.hourlyLimit ?? 6} onChange={(e) => setDraft({ ...draft, image: { ...draft.image, hourlyLimit: +e.target.value } })} /></Field></div><Field label={t("测试画面描述")}><input value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} /></Field><button className="secondary" disabled={!imagePrompt.trim()} onClick={() => action(async () => { await api('/api/settings/providers', 'PUT', draft); const result = await api<{ image_url: string }>('/api/images/generate', 'POST', { prompt: imagePrompt }); setImagePreview(result.image_url); await reload(); })}><Play size={16} />{t("保存并测试生成")}</button>{imagePreview && <img className="service-image-preview" src={imagePreview} alt={t("测试生成结果")} />}</>}
    <div className="form-footer">{(tab === 'llm' || tab === 'tts') && <button className="secondary" onClick={test} disabled={testing}>{testing ? <LoaderCircle size={16} className="spin" /> : tab === 'tts' ? <Volume2 size={16} /> : <RefreshCw size={16} />}{tab === 'tts' ? t("试听") : t("测试连接")}</button>}{tab !== 'asr' && <button className="text-button danger" onClick={() => action(async () => { await api('/api/providers/' + tab + '/key', 'DELETE'); setDraft({ ...draft, [tab]: { ...draft[tab], apiKey: '', hasApiKey: false } }); }, t("密钥已清除"))}><KeyRound size={14} />{t("清除已保存密钥")}</button>}</div>
    {result && <div className="status-note success"><Check size={16} />{t(result)}</div>}
    {validation && <div className="validation-error" role="alert">{t(validation.messageKey, { v0: t(validation.label) })}</div>}
    {naming && <Modal title={t("保存连接方案")} onClose={() => setNaming(false)}><div className="modal-body"><Field label={t("方案名称")}><input autoFocus value={profileName} onChange={(e) => setProfileName(e.target.value)} /></Field><button className="primary" disabled={!profileName.trim()} onClick={() => action(async () => { await api('/api/profiles', 'POST', { name: profileName, providers: draft }); setNaming(false); setProfileName(''); await reload(); }, t("方案已保存，不含密钥"))}><Check size={16} />{t("保存方案")}</button></div></Modal>}
  </div>;
}

export function ScreenPage({ value, desktop, mode, save, action, latest, onPreview }: { value: Companion; desktop: DesktopPreferences; mode?: CompanionMode; save: (value: Companion) => Promise<void>; action: Action; latest: ScreenContext | null; onPreview: () => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState('');
  const state = screenState(desktop, value.screen, mode);
  useEffect(() => { window.desktop?.permission().then((v) => setPermission(v.screen)).catch(() => {}); }, []);
  const patch = (patch: Partial<Companion['screen']>) => setDraft({ ...draft, screen: { ...draft.screen, ...patch } });
  const choose = () => action(async () => {
    if (!window.desktop) throw new Error(t("请在桌面程序中选择观察窗口"));
    setLoading(true);
    try { setSources(await window.desktop.sources()); } finally { setLoading(false); }
  });
  return <div className="settings-page"><PageHeader title={t("屏幕感知")} subtitle={permission === 'denied' ? t("系统屏幕录制权限未开启") : draft.screen.sourceName || t("尚未选择观察窗口")}><SaveButton onClick={() => action(() => save(draft), t("观察设置已保存"))} /></PageHeader>
    <Row label={t("允许屏幕感知")}><Toggle checked={draft.screen.enabled} label={t("角色允许屏幕感知")} onChange={(v) => patch({ enabled: v })} /></Row>
    <Row label={t("实际状态")}><span className={'badge ' + (state.allowed ? 'teal' : '')}>{permission === 'denied' ? t("系统屏幕录制权限未开启") : t(state.reason) || t("屏幕感知已就绪")}</span></Row>
    <div className="capture-preview">{latest ? <img src={latest.imageData} alt={t("最近一次捕获画面")} /> : <div><Monitor size={36} /><span>{draft.screen.sourceName || t("未捕获画面")}</span></div>}</div>
    <div className="form-footer"><button className="secondary" onClick={choose} disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <Monitor size={16} />}{t("选择窗口或屏幕")}</button><button className="secondary" onClick={() => action(onPreview)} disabled={!value.screen.enabled || value.screen.paused || !value.screen.sourceId}><Eye size={16} />{t("捕获预览")}</button></div>
    <h2 className="section-title">{t("截图与消息")}</h2>
    <Field label={t("截图画质")}><select value={draft.screen.quality || 'high'} onChange={(e) => patch({ quality: e.target.value as 'standard' | 'high' })}><option value="high">{t("高清 · PNG · 3200×2000")}</option><option value="standard">{t("标准 · JPEG · 1600×1000")}</option></select></Field>
    <Row label={t("每次发送消息时")}><Toggle checked={draft.screen.onMessage} label={t("每次发送消息时")} onChange={(v) => patch({ onMessage: v })} /></Row>
    <Row label={t("只捕获指定区域")}><Toggle label={t("只捕获指定区域")} checked={!!draft.screen.region} onChange={(v) => patch({ region: v ? { x: 0, y: 0, width: 1, height: 1 } : null })} /></Row>
    {draft.screen.region && <div className="form-grid">{(['x', 'y', 'width', 'height'] as const).map((key) => <Field key={key} label={({ x: t("左侧位置 %"), y: t("顶部位置 %"), width: t("宽度 %"), height: t("高度 %") })[key]}><input type="number" min="0" max="100" value={Math.round(draft.screen.region![key] * 100)} onChange={(e) => patch({ region: { ...draft.screen.region!, [key]: Number(e.target.value) / 100 } })} /></Field>)}</div>}
    <Row label={t("暂停屏幕感知")}><Toggle label={t("暂停屏幕感知")} checked={draft.screen.paused} onChange={(v) => patch({ paused: v })} /></Row>
    <div className="status-note"><span className="status-dot" />{t("原始截图不保存 · 文字与语音发送共用捕获规则")}</div>
    {sources && <Modal title={t("选择观察对象")} onClose={() => setSources(null)}><div className="source-list">{sources.length ? sources.map((source) => <button className="source-option" key={source.id} onClick={() => { patch({ sourceId: source.id, sourceName: source.name, region: null }); setSources(null); }}><img src={source.thumbnail} alt="" /><span>{source.name}</span></button>) : <div className="empty-state">{t("没有可用窗口，请检查屏幕录制权限")}</div>}</div></Modal>}
  </div>;
}
