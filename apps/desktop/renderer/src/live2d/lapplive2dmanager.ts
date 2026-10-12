// @ts-nocheck
/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { ACubismMotion } from '@framework/motion/acubismmotion';
import { csmVector } from '@framework/type/csmvector';

import * as LAppDefine from './lappdefine';
import { LAppModel } from './lappmodel';
import { LAppPal } from './lapppal';
import { LAppSubdelegate } from './lappsubdelegate';

/**
 * サンプルアプリケーションにおいてCubismModelを管理するクラス
 * モデル生成と破棄、タップイベントの処理、モデル切り替えを行う。
 */
export class LAppLive2DManager {
  /**
   * 現在のシーンで保持しているすべてのモデルを解放する
   */
  private releaseAllModel(): void {
    for (let i = 0; i < this._models.getSize(); i++) this._models.at(i).release();
    this._models.clear();
  }

  /**
   * 画面をドラッグした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onDrag(x: number, y: number): void {
    const model: LAppModel = this._models.at(0);

    if (!model || model.gazeEnabled === false) return;
    if (model) {
      model.setDragging(x, y);
    }
  }

  /**
   * 画面をタップした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onTap(x: number, y: number): void {
    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(
        `[APP]tap point: {x: ${x.toFixed(2)} y: ${y.toFixed(2)}}`
      );
    }

    const model: LAppModel = this._models.at(0);

    if (!model) return;

    if (model.hitTest(LAppDefine.HitAreaNameHead, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${LAppDefine.HitAreaNameHead}]`);
      }
      model.setRandomExpression();
    } else if (model.hitTest(LAppDefine.HitAreaNameBody, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${LAppDefine.HitAreaNameBody}]`);
      }
      model.startRandomMotion(
        LAppDefine.MotionGroupTapBody,
        LAppDefine.PriorityNormal,
        this.finishedMotion,
        this.beganMotion
      );
    }
  }

  public setGaze(x: number, y: number, head: boolean): void {
    const model = this._models.at(0);
    if (!model) return;
    model.gazeHead = head ? 1 : 0;
    model.setDragging(x, y);
  }
  public setVoiceMouth(value: number): void {
    for (let i = 0; i < this._models.getSize(); ++i) this._models.at(i).voiceMouth = Math.max(0, Math.min(1, value));
  }

  public configureGaze(enabled: boolean, head: boolean): void {
    const model = this._models.at(0);
    if (!model) return;
    model.gazeEnabled = enabled;
    model.gazeHead = head ? 1 : 0;
    if (!enabled) model.setDragging(0, 0);
  }

  /**
   * 画面を更新するときの処理
   * モデルの更新処理及び描画処理を行う
   */
  public onUpdate(): void {
    const { width, height } = this._subdelegate.getCanvas();

    const projection: CubismMatrix44 = new CubismMatrix44();
    const model: LAppModel = this._models.at(0);

    if (!model) return;

    if (model.getModel()) {
      if (model.getModel().getCanvasWidth() > 1.0 && width < height) {
        // 横に長いモデルを縦長ウィンドウに表示する際モデルの横サイズでscaleを算出する
        model.getModelMatrix().setWidth(2.0);
        projection.scale(1.0, width / height);
      } else {
        projection.scale(height / width, 1.0);
      }

      // 必要があればここで乗算
      if (this._viewMatrix != null) {
        projection.multiplyByMatrix(this._viewMatrix);
      }
    }

    model.update();
    model.draw(projection); // 参照渡しなのでprojectionは変質する。
  }

  /**
   * 次のシーンに切りかえる
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   */
  public nextScene(): void {}

  /**
   * シーンを切り替える
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   * @param index
   */
  public async loadModel(modelUrl: string): Promise<void> {
    if (this._released) return;
    this._pending?.release();
    LAppDefine.configureModel(modelUrl);
    const instance = new LAppModel();
    this._pending = instance;
    instance.setSubdelegate(this._subdelegate);
    instance.loadAssets(LAppDefine.ActiveModelPath, LAppDefine.ActiveModelFile);
    const started = performance.now();
    const ticket = ++this._loadTicket;
    while (!instance.isReady()) {
      if (ticket !== this._loadTicket || this._released) { instance.release(); return; }
      if (instance.loadError || performance.now() - started > 18000) {
        instance.release();
        if (this._pending === instance) this._pending = null;
        throw new Error(instance.loadError || 'Live2D loading timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (ticket !== this._loadTicket || this._released) { instance.release(); return; }
    this._pending = null;
    this.releaseAllModel();
    this._models.pushBack(instance);
  }

  private _loadTicket = 0;
  private _pending: LAppModel = null;
  private _released = false;

  public playMotion(group: string, index: number, priority: number): void {
    const model = this._models.at(0);
    if (!group || !model?.getModel()) return;
    model.startMotion(group, index, priority);
  }

  public setExpression(name: string): void {
    const model = this._models.at(0);
    if (!name || !model?.getModel()) return;
    model.setExpression(name);
  }

  public setViewMatrix(m: CubismMatrix44) {
    for (let i = 0; i < 16; i++) {
      this._viewMatrix.getArray()[i] = m.getArray()[i];
    }
  }

  /**
   * モデルの追加
   */
  public addModel(sceneIndex: number = 0): void {
    this._sceneIndex = sceneIndex;
    if (LAppDefine.ActiveModelFile) {
      this.loadModel(`${LAppDefine.ActiveModelPath}${LAppDefine.ActiveModelFile}`);
    }
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    this._subdelegate = null;
    this._viewMatrix = new CubismMatrix44();
    this._models = new csmVector<LAppModel>();
    this._sceneIndex = 0;
  }

  /**
   * 解放する。
   */
  public release(): void {
    this._released = true;
    this._loadTicket++;
    this._pending?.release();
    this._pending = null;
    this.releaseAllModel();
  }

  /**
   * 初期化する。
   * @param subdelegate
   */
  public initialize(subdelegate: LAppSubdelegate): void {
    this._subdelegate = subdelegate;
  }

  /**
   * 自身が所属するSubdelegate
   */
  private _subdelegate: LAppSubdelegate;

  _viewMatrix: CubismMatrix44; // モデル描画に用いるview行列
  _models: csmVector<LAppModel>; // モデルインスタンスのコンテナ
  private _sceneIndex: number; // 表示するシーンのインデックス値

  // モーション再生開始のコールバック関数
  beganMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Began:');
    console.log(self);
  };
  // モーション再生終了のコールバック関数
  finishedMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Finished:');
    console.log(self);
  };
}
