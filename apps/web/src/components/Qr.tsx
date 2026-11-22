import qrcode from 'qrcode-generator';

/** Plain SVG QR code (byte mode, error correction M). */
export function Qr({ value, size = 180 }: { value: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
