export interface UploadLimits {
  max_files: number;
  max_file_bytes: number;
  max_batch_bytes: number;
}
export function validateUploadFiles(files: {
  name: string;
  size: number;
}[], limits: UploadLimits) {
  const errors: string[] = [];
  if (!files.length)
    errors.push('Choose at least one file.');
  if (files.length > limits.max_files)
    errors.push('Choose up to ' + limits.max_files + ' files per batch.');
  if (files.reduce((sum, file) => sum + file.size, 0) > limits.max_batch_bytes)
    errors.push('This batch exceeds the workspace size limit.');
  for (const file of files) {
    if (!/\.(pdf|jpe?g|png|tiff?|xlsx?|csv)$/i.test(file.name))
      errors.push(file.name + ': unsupported file extension.');
    if (file.size === 0)
      errors.push(file.name + ': this file is empty.');
    if (file.size > limits.max_file_bytes)
      errors.push(file.name + ': exceeds the per-file size limit.');
  }
  return errors;
}
