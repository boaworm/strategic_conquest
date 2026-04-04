import fs from 'fs';
import path from 'path';

export interface NNModel {
  id: string;           // Unique identifier (e.g., 'albert-gen1')
  name: string;         // Display name (e.g., 'Albert Gen1')
  path: string;         // Path to ONNX file
  description?: string; // Optional description
  epoch?: number;       // Training epoch
  accuracy?: number;    // Training accuracy
}

/**
 * Scans a directory for ONNX model files and registers them.
 * Model files should be named: <id>.onnx (e.g., albert-gen1.onnx)
 */
export class NNModelRegistry {
  private models: NNModel[] = [];
  private defaultDir: string;

  constructor(checkpointDir: string) {
    this.defaultDir = checkpointDir;
    this.scanDirectory();
  }

  scanDirectory(): void {
    const dir = process.env.NN_MODELS_DIR || this.defaultDir;
    if (!fs.existsSync(dir)) {
      console.log(`[NNModelRegistry] Directory not found: ${dir}`);
      return;
    }

    const files = fs.readdirSync(dir);
    this.models = files
      .filter(f => f.endsWith('.onnx'))
      .map(f => {
        const id = f.replace('.onnx', '');
        // Parse friendly name from ID: albert-gen1 -> Albert Gen1
        const name = this.formatModelName(id);
        return {
          id,
          name,
          path: path.join(dir, f),
        };
      });

    console.log(`[NNModelRegistry] Found ${this.models.length} models in ${dir}`);
  }

  getModels(): NNModel[] {
    return this.models;
  }

  getModelById(id: string): NNModel | undefined {
    return this.models.find(m => m.id === id);
  }

  private formatModelName(id: string): string {
    // Convert kebab-case to Title Case
    return id
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
}
