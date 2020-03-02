/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tfconv from '@tensorflow/tfjs-converter';
import * as tf from '@tensorflow/tfjs-core';
import {scaleBoxCoordinates} from './box';

export class HandDetector {
  private model: tfconv.GraphModel;
  private width: number;
  private height: number;
  private iouThreshold: number;
  private scoreThreshold: number;

  private anchors: tf.Tensor2D;
  private inputSizeTensor: tf.Tensor1D;
  private doubleInputSizeTensor: tf.Tensor1D;

  constructor(
      model: tfconv.GraphModel, width: number, height: number,
      ANCHORS: Array<{x_center: number, y_center: number}>,
      iouThreshold: number, scoreThreshold: number) {
    this.model = model;
    this.width = width;
    this.height = height;
    this.iouThreshold = iouThreshold;
    this.scoreThreshold = scoreThreshold;

    this.anchors = tf.tensor2d(
        ANCHORS.map(anchor => ([anchor.x_center, anchor.y_center])));
    this.inputSizeTensor = tf.tensor1d([width, height]);
    this.doubleInputSizeTensor = tf.tensor1d([width * 2, height * 2]);
  }

  normalizeBoxes(boxes: tf.Tensor) {
    const boxOffsets = tf.slice(boxes, [0, 0], [-1, 2]);
    const boxSizes = tf.slice(boxes, [0, 2], [-1, 2]);

    const boxCenterPoints =
        tf.add(tf.div(boxOffsets, this.inputSizeTensor), this.anchors);

    const halfBoxSizes = tf.div(boxSizes, this.doubleInputSizeTensor);
    const startPoints = tf.sub(boxCenterPoints, halfBoxSizes);
    const endPoints = tf.add(boxCenterPoints, halfBoxSizes);

    return tf.concat2d(
        [
          tf.mul(startPoints as tf.Tensor2D, this.inputSizeTensor) as
              tf.Tensor2D,
          tf.mul(endPoints, this.inputSizeTensor) as tf.Tensor2D
        ],
        1);
  }

  _decode_landmarks(raw_landmarks: tf.Tensor) {
    const relative_landmarks = tf.add(
        tf.div(raw_landmarks.reshape([-1, 7, 2]), this.inputSizeTensor),
        this.anchors.reshape([-1, 1, 2]));

    return tf.mul(relative_landmarks, this.inputSizeTensor);
  }

  _getBoundingBox(input: tf.Tensor) {
    return tf.tidy(() => {
      const img = tf.mul(tf.sub(input, 0.5), 2);  // make input [-1, 1]

      // 19:
      //  0: score
      //  1,2,3,4: raw boxes
      //  5-14: raw landmarks

      // The model returns a tensor with the following shape:
      //  [1 (batch), 2944 (anchor points), 19 (data for each anchor)]
      // Squeezing immediately because we are not batching inputs.
      const prediction: tf.Tensor2D =
          (this.model.predict(img) as tf.Tensor3D).squeeze();

      // Regression score for each anchor point.
      const scores: tf.Tensor1D =
          tf.sigmoid(tf.slice(prediction, [0, 0], [-1, 1])).squeeze();

      // Bounding box for each anchor point.
      const rawBoxes = tf.slice(prediction, [0, 1], [-1, 4]);
      const boxes = this.normalizeBoxes(rawBoxes);

      const box_indices =
          tf.image
              .nonMaxSuppression(
                  boxes, scores, 1, this.iouThreshold, this.scoreThreshold)
              .arraySync();
      if (box_indices.length === 0) {
        return [null, null];
      }

      const box_index = box_indices[0];
      const result_box = tf.slice(boxes, [box_index, 0], [1, -1]);

      const raw_landmarks = tf.slice(prediction, [0, 5], [-1, 14]);
      const landmarks = this._decode_landmarks(raw_landmarks);

      const result_landmarks =
          tf.slice(landmarks, [box_index, 0], [1]).reshape([-1, 2]);

      return [result_box, result_landmarks];
    });
  }

  getSingleBoundingBox(input: tf.Tensor4D) {
    const original_h = input.shape[1];
    const original_w = input.shape[2];

    const image =
        tf.tidy(() => input.resizeBilinear([this.width, this.height]).div(255));
    const bboxes_data = this._getBoundingBox(image);

    if (!bboxes_data[0]) {
      return null;
    }

    const bboxes = bboxes_data[0].arraySync() as any;
    const landmarks = bboxes_data[1].arraySync() as any;

    const factors: [number, number] =
        [original_w / this.width, original_h / this.height];

    const bb = scaleBoxCoordinates(
        {
          startPoint: bboxes[0].slice(0, 2),
          endPoint: bboxes[0].slice(2, 4),
          landmarks
        },
        factors);

    image.dispose();
    bboxes_data[0].dispose();
    bboxes_data[1].dispose();

    return bb;
  }
}