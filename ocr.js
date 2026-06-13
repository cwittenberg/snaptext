/**
 * OCR preprocessing module that uses a rule-based algo to maximize accuracy without relying on ML or LLM type of solutions.
 * Tesseract is used - but too frequently it just returns utter crap. Algo utilizes imagemagick for preprocessing.
 * * Explanation of how it works (step-wise):
 * 0. Fast QR Check:
 * - Checks for a QR Code via zbarimg. If found, instantly returns the decoded text.
 * 1. Image Analysis:
 * - Extracts the width and height of the screenshot.
 * - Uses ImageMagick to calculate the mean brightness of the image.
 * 2. Preprocessing with mogrify:
 * - Converts the image to strictly grayscale and maximizes contrast.
 * - Upscales small images by 300% (imho, Tesseract performs really poorly on small screen snips).
 * - Dark Mode Inversion: when brightness indicates UI - the image colors are negated 
 * 3. PSM (Page Segmentation Mode) Routing:
 * - Based on the aspect ratio and dimensions, a primary and fallback PSM are selected:
 * Single Line: Width is much larger than height (Primary: 7, Fallback: 13)
 * Small Button/Word: Very small dimensions (Primary: 8, Fallback: 7)
 * Full Document: Very large dims (Primary: 3, Fallback: 6)
 * Text Block: Everything else (Primary: 6, Fallback: 11)
 * 4. Primary OCR Pass:
 * - Runs Tesseract using the Primary PSM. Outputs both plain text (.txt) and tab-separated values (.tsv) for detailed confidence metrics.
 * 5. Quality eval:
 * - Parses the TSV file to calculate the average word confidence.
 * - Calculates the crap ratio (ok, "Garbage Ratio") - which is the proportion of non-alphanumeric/symbol characters
 * - If the result meets high conf + low garbage - it is immediately accepted and returned.
 * 6. Fallback OCR:
 * - If the primary pass fails the quality check, a second pass is executed using the Fallback PSM.
 * - Both passes are scored heuristically (conf + length - garbage penalties).
 * - The highest-scoring result wins.
 * 7. Text Cleanup:
 * - Tesseract often hallucinates excessive empty lines when parsing empty space.
 * - Collapses 3+ consecutive newlines down to standard double line-breaks.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

export class OcrProcessor {
    /**
     * @param {Gio.Cancellable} cancellable - Token to abort async operations
     * @param {Set} activeProcesses - Tracker for spawned child processes
     * @param {Function} notifyErrorFn - Callback to bubble UI error notifications
     * @param {Function} logDebugFn - Callback to log debug info if enabled
     */
    constructor(cancellable, activeProcesses, notifyErrorFn, logDebugFn) {
        this._cancellable = cancellable;
        this._activeProcesses = activeProcesses;
        this._notifyError = notifyErrorFn;
        this._logDebug = logDebugFn || function() {};
    }

    _isCancelled() {
        return !this._cancellable || this._cancellable.is_cancelled();
    }

    // Awaits the completion of a Gio.Subprocess (no output reading, just exit status)
    async _waitForProcess(process) {
        return new Promise(resolve => {
            process.wait_async(this._cancellable, (proc, result) => {
                try {
                    proc.wait_finish(result);
                    resolve(proc.get_successful());
                } catch (error) {
                    if (!this._isCancelled()) {
                        this._notifyError(`Process wait failed: ${error}`);
                    }
                    resolve(false);
                }
            });
        });
    }

    // Awaits a Gio.Subprocess and captures its stdout buffer
    async _readProcess(process) {
        return new Promise(resolve => {
            process.communicate_utf8_async(null, this._cancellable, (proc, result) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(result);
                    resolve({ ok: proc.get_successful(), stdout });
                } catch (error) {
                    if (!this._isCancelled()) {
                        this._notifyError(`Process output read failed: ${error}`);
                    }
                    resolve({ ok: false, stdout: '' });
                }
            });
        });
    }

    /**
     * Attempts to read a QR code from the image using zbarimg.
     * @returns {String|null} Decoded QR text or null if not found.
     */
    async _readQrCode(imagePath) {
        if (!GLib.find_program_in_path('zbarimg')) {
            return null; // Gracefully fallback to Tesseract if zbar is not installed
        }

        try {
            let zbar = Gio.Subprocess.new(
                ['zbarimg', '--quiet', '--raw', imagePath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            this._activeProcesses.add(zbar);
            let result = await this._readProcess(zbar);
            this._activeProcesses.delete(zbar);

            if (result.ok && result.stdout && result.stdout.trim().length > 0) {
                return result.stdout.trim();
            }
        } catch (error) {
            this._logDebug(`zbarimg QR code detection failed: ${error}`);
        }

        return null;
    }

    /**
     * Discovers all installed language packs for Tesseract.
     * Tesseract parses better when fed explicit languages rather than guessing.
     * * @returns {String} A plus-separated string of languages (e.g. "eng+fra+spa")
     */
    async _availableTesseractLanguages() {
        let fallback = 'eng';

        try {
            let listLangs = Gio.Subprocess.new(
                ['tesseract', '--list-langs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            this._activeProcesses.add(listLangs);
            let result = await this._readProcess(listLangs);
            this._activeProcesses.delete(listLangs);

            if (!result.ok || !result.stdout) {
                return fallback;
            }

            let langs = [];
            let lines = result.stdout.split('\n').map(line => line.trim());
            
            // Skip the "List of available languages:" header
            let headerIndex = lines.findIndex(line => line.startsWith('List of'));

            for (let i = headerIndex + 1; i > 0 && i < lines.length; i++) {
                let lang = lines[i];
                // Ignore 'osd' (Orientation and Script Detection) as an OCR language
                if (lang && lang !== 'osd' && /^[a-zA-Z0-9_]+$/.test(lang)) {
                    langs.push(lang);
                }
            }

            return langs.length > 0 ? langs.join('+') : fallback;
        } catch (error) {
            if (!this._isCancelled()) {
                this._notifyError(`Could not read Tesseract languages: ${error}`);
            }
            return fallback;
        }
    }

    /**
     * Per algo, this execs a single OCR pass with a specific Page Segmentation Mode (PSM).
     * * @param {String} imagePath - Path to the temporary screenshot
     * @param {Number} psm - Tesseract PSM integer
     * @param {String} langs - Tesseract language string
     * @returns {Object|null} Result object containing text, confidence, and garbage ratio.
     */
    async _runTesseractPass(imagePath, psm, langs) {
        if (!GLib.find_program_in_path('tesseract')) {
            return null;
        }

        this._logDebug(`Executing tesseract pass with PSM: ${psm} and Langs: ${langs}`);

        // Tesseract automatically appends .txt and .tsv to the specified output prefix
        let tmpPrefix = imagePath.replace('.png', '');
        let ocr = Gio.Subprocess.new(
            // Force LSTM engine (--oem 1) and assume 300 DPI for stability
            ['tesseract', imagePath, tmpPrefix, '-l', langs, '--dpi', '300', '--oem', '1', '--psm', String(psm), 'txt', 'tsv'],
            Gio.SubprocessFlags.NONE
        );

        this._activeProcesses.add(ocr);
        let ok = await this._waitForProcess(ocr);
        this._activeProcesses.delete(ocr);

        this._logDebug(`Tesseract execution completed. Exit ok: ${ok}`);

        if (!ok || this._isCancelled()) {
            return null;
        }

        let txtPath = `${tmpPrefix}.txt`;
        let tsvPath = `${tmpPrefix}.tsv`;

        let text = '';
        let tsv = '';

        // Read the resulting files asynchronously
        try {
            let txtFile = Gio.File.new_for_path(txtPath);
            let txtBytes = await new Promise((resolve, reject) => {
                txtFile.load_contents_async(this._cancellable, (file, res) => {
                    try {
                        let [success, contents] = file.load_contents_finish(res);
                        if (success) {
                            resolve(contents);
                        } else {
                            reject(new Error("Failed to read TXT contents."));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            text = new TextDecoder('utf-8').decode(txtBytes).trim();
            this._logDebug(`Read TXT output. Length: ${text.length}`);
        } catch (e) {
            this._logDebug(`Could not read OCR txt output: ${e}`);
        }

        try {
            let tsvFile = Gio.File.new_for_path(tsvPath);
            let tsvBytes = await new Promise((resolve, reject) => {
                tsvFile.load_contents_async(this._cancellable, (file, res) => {
                    try {
                        let [success, contents] = file.load_contents_finish(res);
                        if (success) {
                            resolve(contents);
                        } else {
                            reject(new Error("Failed to read TSV contents."));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            tsv = new TextDecoder('utf-8').decode(tsvBytes);
            this._logDebug(`Read TSV output. Length: ${tsv.length}`);
        } catch (e) {
            this._logDebug(`Could not read OCR tsv output: ${e}`);
        }

        // Clean up temporary files asynchronously
        try {
            let txtFile = Gio.File.new_for_path(txtPath);
            if (txtFile.query_exists(null)) {
                await new Promise((resolve) => {
                    txtFile.delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                        try { file.delete_finish(res); } catch (e) {}
                        resolve();
                    });
                });
            }
        } catch (e) {
            this._logDebug(`Failed to delete temporary txt file: ${e}`);
        }

        try {
            let tsvFile = Gio.File.new_for_path(tsvPath);
            if (tsvFile.query_exists(null)) {
                await new Promise((resolve) => {
                    tsvFile.delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                        try { file.delete_finish(res); } catch (e) {}
                        resolve();
                    });
                });
            }
        } catch (e) {
            this._logDebug(`Failed to delete temporary tsv file: ${e}`);
        }

        // --- Quality Metrics Calculation ---
        let totalConf = 0;
        let wordCount = 0;

        let lines = tsv.split('\n');
        for (let i = 1; i < lines.length; i++) {
            let cols = lines[i].split('\t');
            if (cols.length >= 12) {
                let conf = parseFloat(cols[10]); // Column 10 is confidence (0-100)
                let wordText = cols[11].trim();  // Column 11 is the extracted word
                
                // Tesseract TSV uses -1 conf for block/paragraph container rows; we only want valid text words
                if (wordText.length > 0 && conf >= 0) {
                    totalConf += conf;
                    wordCount++;
                }
            }
        }

        let confidence = wordCount > 0 ? (totalConf / wordCount) : 0;
        let charCount = text.length;

        // Calculate crap rate ("Garbage Ratio") of how much of the output is weird symbols/hallucinating crap (tesseract does this)
        let garbageMatches = text.match(/[^a-zA-Z0-9\s.,!?\'"()\-]/g);
        let garbageCount = garbageMatches ? garbageMatches.length : 0;
        let garbageRatio = charCount > 0 ? (garbageCount / charCount) : 0;

        this._logDebug(`Metrics for PSM ${psm} -> conf: ${confidence.toFixed(2)}, words: ${wordCount}, chars: ${charCount}, garbageRatio: ${garbageRatio.toFixed(3)}`);

        return { text, confidence, wordCount, charCount, garbageRatio };
    }

    /**
     * Determines which OCR result is better - when multiple passes were executed.
     * Favors high conf. and word count, heavily penalizes crap symbols in ouput.
     */
    _calculateScore(res) {
        if (!res) return -9999;
        return res.confidence 
             + Math.min(res.wordCount, 20) * 0.5 
             + Math.min(res.charCount, 160) * 0.03 
             - (res.garbageRatio * 25);
    }

    /**
     * Main orchestrator function. Takes a screenshot path and returns the best extracted text.
     */
    async processImage(imagePath) {
        this._logDebug(`Processing image: ${imagePath}`);

        // --- STEP 0: Fast QR Code Detection ---
        let qrText = await this._readQrCode(imagePath);
        if (qrText && !this._isCancelled()) {
            this._logDebug('QR code successfully detected. Bypassing OCR.');
            return { text: qrText, isQr: true }; // Successfully decoded a QR code, skip Tesseract OCR entirely!
        }

        // --- STEP 1: Layout & Brightness Analysis ---
        let width = 0, height = 0, meanBrightness = 1.0;
        
        try {
            // Get native screenshot dimensions to help classify layout
            let [, w, h] = GdkPixbuf.Pixbuf.get_file_info(imagePath);
            width = w;
            height = h;
            this._logDebug(`Image dimensions: ${width}x${height}`);
        } catch(e) {
            this._logDebug(`Could not fetch native image dims: ${e}`);
        }

        if (GLib.find_program_in_path('identify') && GLib.find_program_in_path('mogrify')) {
            try {
                // Calculate average brightness (0.0 = black, 1.0 = white)
                let identify = Gio.Subprocess.new(
                    ['identify', '-format', '%[fx:mean]', imagePath],
                    Gio.SubprocessFlags.STDOUT_PIPE
                );
                this._activeProcesses.add(identify);
                let result = await this._readProcess(identify);
                this._activeProcesses.delete(identify);

                if (result.ok && result.stdout) {
                    meanBrightness = parseFloat(result.stdout.trim());
                    this._logDebug(`Image mean brightness: ${meanBrightness}`);
                }

                // --- STEP 2: Preprocessing ---
                let mogrifyArgs = ['mogrify', '-colorspace', 'gray', '-type', 'grayscale', '-contrast-stretch', '0', '-sharpen', '0x1'];
                
                // Upscale if the snip is relatively small (Tesseract needs dense pixels)
                if (width < 1500 && height < 1500) {
                    mogrifyArgs.push('-resize', '300%');
                    this._logDebug('Applying 300% upscale via mogrify.');
                }

                // Dark Mode Fix: Invert colors if the image is mostly dark
                if (!isNaN(meanBrightness) && meanBrightness < 0.45) {
                    mogrifyArgs.push('-negate'); 
                    this._logDebug('Image is dark. Applying negate for OCR preprocessing.');
                }

                mogrifyArgs.push(imagePath);

                // Apply the modifications directly to the temp file
                let mogrify = Gio.Subprocess.new(mogrifyArgs, Gio.SubprocessFlags.NONE);
                this._activeProcesses.add(mogrify);
                await this._waitForProcess(mogrify);
                this._activeProcesses.delete(mogrify);
            } catch (error) {
                this._logDebug(`Image preprocessing failed: ${error}`);
            }
        }

        if (this._isCancelled()) return null;

        // --- STEP 3: PSM Routing ---PassPass
        let primaryPsm = 6;  // Assume standard uniform text block by default
        let fallbackPsm = 11; // Sparse text mode
        let aspectRatio = height > 0 ? (width / height) : 1;

        if (height <= 90 && aspectRatio >= 4) {
            // Very wide and short -> Single Line of Text
            primaryPsm = 7; fallbackPsm = 13;
        } else if (width <= 220 && height <= 100) {
            // Very small bounding box -> A single Word or UI Button
            primaryPsm = 8; fallbackPsm = 7;
        } else if (width >= 900 && height >= 900) {
            // Large selection -> Full Document or Page
            primaryPsm = 3; fallbackPsm = 6;
        }

        this._logDebug(`Routed PSMs. Primary: ${primaryPsm}, Fallback: ${fallbackPsm}`);

        let langs = await this._availableTesseractLanguages();
        this._logDebug(`Resolved Tesseract languages: ${langs}`);

        if (this._isCancelled()) return null;

        // --- STEP 4: Primary pass through tess ---
        let res1 = await this._runTesseractPass(imagePath, primaryPsm, langs);
        if (this._isCancelled()) return null;

        // --- STEP 5: Quality eval ---
        let accept = false;
        if (res1 && res1.wordCount > 0 && res1.charCount >= 2 && res1.confidence >= 65 && res1.garbageRatio < 0.35) {
            accept = true; // Results are excellent, skip fallback
            this._logDebug(`Primary pass accepted. Metrics pass thresholds.`);
        } else {
            this._logDebug(`Primary pass rejected based on metrics.`);
        }

        let finalRes = res1;

        // --- STEP 6: Fallback OCR  ---
        if (!accept) {
            this._logDebug(`Executing fallback pass.`);
            let res2 = await this._runTesseractPass(imagePath, fallbackPsm, langs);
            if (this._isCancelled()) return null;

            let score1 = this._calculateScore(res1);
            let score2 = this._calculateScore(res2);

            this._logDebug(`Comparing scores. Score1: ${score1.toFixed(2)}, Score2: ${score2.toFixed(2)}`);

            // Keep the best result
            if (score2 > score1) {
                this._logDebug('Fallback pass won.');
                finalRes = res2;
            } else {
                this._logDebug('Primary pass won despite poor initial metrics.');
            }
        }

        if (!finalRes || !finalRes.text) {
            this._logDebug('No text extracted.');
            return { text: '', isQr: false };
        }

        // --- STEP 7: Text Cleanup ---
        // Strip excessive hallucinated newlines from empty areas
        return { text: finalRes.text.replace(/\n{3,}/g, '\n\n'), isQr: false }; 
    }
}


