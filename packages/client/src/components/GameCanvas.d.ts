import { type PlayerView, type CityView } from '@sc/shared';
interface Props {
    view: PlayerView;
    onCityClick?: (city: CityView) => void;
    selectedCityId?: string | null;
}
export declare function GameCanvas({ view, onCityClick, selectedCityId }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=GameCanvas.d.ts.map